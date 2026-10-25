#!/usr/bin/env python3
"""使用本机现有个人开发签名材料重签 IPA，并可安装到明确的实体设备。"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

UTC = dt.timezone.utc
PROFILE_DIRS = (
    Path.home() / 'Library/Developer/Xcode/UserData/Provisioning Profiles',
    Path.home() / 'Library/MobileDevice/Provisioning Profiles',
)
THIN = {b'\xcf\xfa\xed\xfe': ('<', True), b'\xce\xfa\xed\xfe': ('<', False),
        b'\xfe\xed\xfa\xcf': ('>', True), b'\xfe\xed\xfa\xce': ('>', False)}
FAT = {b'\xca\xfe\xba\xbe': ('>', False), b'\xbe\xba\xfe\xca': ('<', False),
       b'\xca\xfe\xba\xbf': ('>', True), b'\xbf\xba\xfe\xca': ('<', True)}


class Blocked(Exception):
    def __init__(self, reason, message, details=None):
        super().__init__(message)
        self.reason, self.details = reason, details


def require(ok, reason, message, details=None):
    if not ok:
        raise Blocked(reason, message, details)


def utc(value):
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def stamp(path):
    s = path.stat()
    return {'sha256': digest(path), 'sizeBytes': s.st_size, 'mtimeNs': s.st_mtime_ns}


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


class Commands:
    def __init__(self):
        self.records = []

    def run(self, args, data=None, timeout=60, check=True):
        args = [str(x) for x in args]
        try:
            p = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            self.records.append({'argv': args, 'exitCode': None, 'error': '命令超时，未重试'})
            raise Blocked('command-timeout', '命令超时，已停止：' + args[0])
        self.records.append({'argv': args, 'exitCode': p.returncode})
        if check and p.returncode:
            raise Blocked('command-failed', '命令失败，未重试：' + args[0], {
                'argv': args, 'exitCode': p.returncode,
                'stderr': p.stderr.decode(errors='replace')[-6000:],
            })
        return p

    def device(self, args, folder, filename, timeout=45):
        path = folder / filename
        p = self.run(['xcrun', 'devicectl', *args, '--json-output', path,
                      '--timeout', str(timeout)], timeout=timeout + 15, check=False)
        document = json.loads(path.read_text()) if path.exists() else {}
        if p.returncode:
            text = p.stdout.decode(errors='replace') + p.stderr.decode(errors='replace')
            save_json(folder / (filename + '.command.json'), {
                'exitCode': p.returncode, 'stdout': p.stdout.decode(errors='replace'),
                'stderr': p.stderr.decode(errors='replace'),
            })
            reason = ('capacity-full' if 'maximum number of installed apps using a free developer profile'
                      in text + json.dumps(document) else 'device-command-failed')
            raise Blocked(reason, '设备操作失败；查看实际回执：' + str(path), {
                'receipt': str(path), 'error': document.get('error'),
            })
        return document.get('result', {})


def identities(commands):
    raw = commands.run(['security', 'find-identity', '-v', '-p', 'codesigning']).stdout
    return set(x.decode().upper() for x in re.findall(rb'\b([0-9a-fA-F]{40})\s+"', raw))


def read_profile(commands, path):
    raw = commands.run(['security', 'cms', '-D', '-i', path]).stdout
    p = plistlib.loads(raw)
    teams = p.get('TeamIdentifier', [])
    prefixes = p.get('ApplicationIdentifierPrefix', [])
    require(len(teams) == 1 and prefixes, 'invalid-profile', '描述文件缺少唯一 Team 或应用标识前缀')
    ent = p.get('Entitlements', {})
    app_id = ent.get('application-identifier', '')
    prefix = next((x for x in prefixes if app_id.startswith(x + '.')), None)
    require(prefix, 'invalid-profile', '描述文件中的应用标识与前缀不一致')
    return {'path': str(path.resolve()), 'name': p.get('Name'), 'uuid': p.get('UUID'),
            'team': teams[0], 'prefix': prefix, 'pattern': app_id[len(prefix) + 1:],
            'created': utc(p['CreationDate']), 'expires': utc(p['ExpirationDate']),
            'entitlements': ent, 'devices': p.get('ProvisionedDevices', []),
            'certificates': p.get('DeveloperCertificates', []), 'sha256': digest(path)}


def profile_public(profile, device=None):
    return {'path': profile['path'], 'name': profile['name'], 'uuid': profile['uuid'],
            'teamId': profile['team'], 'bundlePattern': profile['pattern'],
            'expiresAt': profile['expires'].isoformat(), 'sha256': profile['sha256'],
            'deviceCount': len(profile['devices']),
            'deviceCovered': device['udid'] in profile['devices'] if device else None}


def certificate_fact(commands, certificate, team):
    p = commands.run(['openssl', 'x509', '-inform', 'DER', '-noout', '-subject', '-dates',
                      '-nameopt', 'sep_multiline,utf8'], data=certificate)
    text = p.stdout.decode()
    ou = re.search(r'^\s*OU\s*=\s*(\S+)\s*$', text, re.M)
    require(ou and ou.group(1) == team, 'certificate-team-mismatch', '公开证书 OU 与 profile Team 不匹配')
    dates = {}
    for label in ('notBefore', 'notAfter'):
        m = re.search(r'^' + label + r'=(.+)$', text, re.M)
        require(m, 'invalid-certificate', '公开证书有效期缺失')
        dates[label] = dt.datetime.strptime(m.group(1), '%b %d %H:%M:%S %Y %Z').replace(tzinfo=UTC)
    return {'sha1': hashlib.sha1(certificate).hexdigest().upper(), **dates}


def all_profiles(commands, explicit=None):
    paths = [Path(explicit).expanduser().resolve()] if explicit else sorted({
        p for directory in PROFILE_DIRS if directory.is_dir() for p in directory.glob('*.mobileprovision')})
    return [read_profile(commands, p) for p in paths]


def list_devices(commands, folder):
    result = commands.device(['list', 'devices'], folder, 'devices.json')
    items = []
    for raw in result.get('devices', []):
        hp, cp, dp = (raw.get(k, {}) for k in ('hardwareProperties', 'connectionProperties', 'deviceProperties'))
        if cp.get('transportType') == 'sameMachine' or not hp.get('udid'):
            continue
        items.append({'id': raw['identifier'], 'udid': hp['udid'], 'name': dp.get('name'),
                      'model': hp.get('productType'), 'state': cp.get('tunnelState'),
                      'transport': cp.get('transportType')})
    return items


def resolve_device(commands, folder, selector):
    candidates = list_devices(commands, folder)
    if selector:
        candidates = [x for x in candidates if selector in (x['id'], x['udid'], x['name'])]
    else:
        candidates = [x for x in candidates if x['state'] == 'connected']
    require(len(candidates) == 1, 'device-ambiguous', '没有唯一匹配的实体设备；请指定 CoreDevice ID 或 UDID',
            [{k: x[k] for k in ('id', 'name', 'model', 'state')} for x in candidates])
    device = candidates[0]
    result = commands.device(['device', 'info', 'details', '--device', device['id']], folder, 'device-details.json')
    hp, dp, cp = (result.get(k, {}) for k in ('hardwareProperties', 'deviceProperties', 'connectionProperties'))
    require(hp.get('udid') == device['udid'] and cp.get('tunnelState') == 'connected',
            'device-unavailable', '目标设备未建立可用连接，请连接、解锁并信任此 Mac')
    require(dp.get('developerModeStatus') == 'enabled', 'developer-mode-disabled', '目标设备需要开启开发者模式')
    device.update({'name': dp.get('name'), 'marketingName': hp.get('marketingName'),
                   'osVersion': dp.get('osVersionNumber')})
    return device


def minimal_entitlements(profile, bundle):
    expected = {'application-identifier': profile['prefix'] + '.' + bundle,
                'com.apple.developer.team-identifier': profile['team'], 'get-task-allow': True,
                'keychain-access-groups': [profile['prefix'] + '.' + bundle]}
    allowed = profile['entitlements']
    for key, value in expected.items():
        actual = allowed.get(key)
        if isinstance(value, list):
            ok = isinstance(actual, list) and all(any(fnmatch.fnmatchcase(v, pattern)
                 for pattern in actual) for v in value)
        elif isinstance(value, bool):
            ok = actual is value
        else:
            ok = isinstance(actual, str) and fnmatch.fnmatchcase(value, actual)
        require(ok, 'entitlement-not-allowed', '描述文件不允许最小个人开发权限：' + key)
    return expected


def choose_material(commands, args, original_bundle, device):
    valid = identities(commands)
    require(valid, 'missing-identity', '本机没有有效代码签名身份')
    now = dt.datetime.now(UTC)
    candidates, uncovered = [], []
    for profile in all_profiles(commands, args.profile):
        if args.team and args.team != profile['team']:
            continue
        if not profile['created'] <= now < profile['expires'] or profile['entitlements'].get('get-task-allow') is not True:
            continue
        bundle = args.bundle_id or (original_bundle if fnmatch.fnmatchcase(original_bundle, profile['pattern'])
                                    else profile['pattern'] if '*' not in profile['pattern'] else None)
        if not bundle or not fnmatch.fnmatchcase(bundle, profile['pattern']):
            continue
        certs = []
        for cert in profile['certificates']:
            fp = hashlib.sha1(cert).hexdigest().upper()
            if fp not in valid or (args.identity and fp != args.identity.upper()):
                continue
            fact = certificate_fact(commands, cert, profile['team'])
            if fact['notBefore'] <= now < fact['notAfter']:
                certs.append(fact)
        if not certs:
            continue
        minimal_entitlements(profile, bundle)
        if device and device['udid'] not in profile['devices']:
            uncovered.append(profile_public(profile, device))
            continue
        cert = max(certs, key=lambda x: (x['notBefore'], x['notAfter'], x['sha1']))
        candidates.append((profile, bundle, cert))
    require(candidates, 'device-not-provisioned' if uncovered else 'missing-profile',
            '缺少覆盖目标的个人开发描述文件或有效身份；需要更新 profile' if uncovered else
            '没有匹配的有效个人开发描述文件；用 inventory 查看材料后指定 --profile / --bundle-id', uncovered)
    if not args.bundle_id and any(bundle == original_bundle for _, bundle, _ in candidates):
        candidates = [c for c in candidates if c[1] == original_bundle]
    groups = {(p['team'], b) for p, b, _ in candidates}
    require(len(groups) == 1, 'material-ambiguous', '有多个 Team 或 Bundle ID 候选，请指定 --profile、--team 或 --bundle-id',
            [dict(profile_public(p, device), targetBundleId=b) for p, b, _ in candidates])
    return max(candidates, key=lambda c: (c[0]['expires'], c[0]['created'], c[0]['path']))


def validate_zip(source, destination):
    with zipfile.ZipFile(source) as archive:
        seen, links = set(), set()
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            require(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.filename,
                    'invalid-archive', 'ZIP 路径越界')
            normalized = str(name)
            require(normalized not in seen, 'invalid-archive', 'ZIP 有重复路径：' + normalized)
            seen.add(normalized)
            if stat.S_ISLNK(entry.external_attr >> 16):
                links.add(normalized)
                target = archive.read(entry).decode('utf-8')
                require(not PurePosixPath(target).is_absolute() and
                        (destination / str(name.parent) / target).resolve().is_relative_to(destination.resolve()),
                        'invalid-archive', 'ZIP 符号链接越界')
        for name in seen:
            require(not any(str(parent) in links for parent in PurePosixPath(name).parents),
                    'invalid-archive', 'ZIP 通过符号链接写入子路径')


def tree_manifest(root):
    result = {}
    for p in sorted(root.rglob('*')):
        rel = p.relative_to(root).as_posix()
        if p.is_symlink():
            require(p.resolve().is_relative_to(root.resolve()), 'unsafe-symlink', '解包后发现越界符号链接：' + rel)
            result[rel] = {'kind': 'symlink', 'target': os.readlink(p), 'mode': stat.S_IMODE(p.lstat().st_mode)}
        elif p.is_file():
            result[rel] = {'kind': 'file', 'sha256': digest(p), 'mode': stat.S_IMODE(p.stat().st_mode)}
    return result


def macho_sections(path):
    """检查各 Mach-O 切片的加密标志，并为实际 section 内容建立不可变证据。"""
    length = path.stat().st_size
    with path.open('rb') as stream:
        magic = stream.read(4)
        if magic in THIN:
            slices = [(0, length)]
        elif magic in FAT:
            endian, wide = FAT[magic]
            count = struct.unpack(endian + 'I', stream.read(4))[0]
            require(0 < count < 65, 'invalid-macho', 'Mach-O 切片数量异常')
            slices = []
            for _ in range(count):
                values = struct.unpack(endian + ('IIQQII' if wide else 'IIIII'), stream.read(32 if wide else 20))
                slices.append((values[2], values[3]))
        else:
            return None
        facts = []
        for offset, size in slices:
            require(offset + size <= length, 'invalid-macho', 'Mach-O 切片越界')
            stream.seek(offset)
            magic = stream.read(4)
            require(magic in THIN, 'invalid-macho', 'Mach-O 切片头无效')
            endian, wide = THIN[magic]
            header = struct.unpack(endian + 'IIIIII', stream.read(24))
            cpu, subtype, filetype, ncmds, sizeofcmds, _ = header
            if wide:
                stream.read(4)
            command_start = stream.tell()
            command_end = command_start + sizeofcmds
            require(ncmds < 100000 and command_end <= offset + size, 'invalid-macho', 'Mach-O 命令区无效')
            sections = []
            for _ in range(ncmds):
                start = stream.tell()
                command, cmdsize = struct.unpack(endian + 'II', stream.read(8))
                require(cmdsize >= 8 and start + cmdsize <= command_end, 'invalid-macho', 'Mach-O 命令越界')
                if command in (0x21, 0x2c):
                    cryptid = struct.unpack(endian + 'III', stream.read(12))[2]
                    require(cryptid == 0, 'encrypted-macho', '发现 FairPlay 加密 Mach-O，不能按本流程重签：' + str(path))
                if command in (0x19, 0x1):
                    segment64 = command == 0x19
                    segname = stream.read(16).split(b'\0')[0].decode()
                    rest = stream.read(48 if segment64 else 32)
                    nsects = struct.unpack(endian + 'I', rest[-8:-4])[0]
                    section_size = 80 if segment64 else 68
                    require(nsects * section_size <= cmdsize - (72 if segment64 else 56),
                            'invalid-macho', 'Mach-O section 表越界')
                    for _ in range(nsects):
                        row = stream.read(section_size)
                        name = row[:16].split(b'\0')[0].decode()
                        addr, sectsize, fileoff = struct.unpack_from(endian + ('QQI' if segment64 else 'III'), row, 32)
                        flags = struct.unpack_from(endian + 'I', row, 64 if segment64 else 56)[0]
                        if (flags & 0xff) in (1, 0xc, 0x12):
                            continue
                        require(fileoff + sectsize <= size, 'invalid-macho', 'Mach-O section 内容越界')
                        position = stream.tell()
                        stream.seek(offset + fileoff)
                        h = hashlib.sha256()
                        remaining = sectsize
                        while remaining:
                            block = stream.read(min(1024 * 1024, remaining))
                            require(block, 'invalid-macho', 'Mach-O section 读取提前结束')
                            h.update(block)
                            remaining -= len(block)
                        stream.seek(position)
                        sections.append({'segment': segname, 'section': name, 'address': addr,
                                         'size': sectsize, 'sha256': h.hexdigest()})
                stream.seek(start + cmdsize)
            facts.append({'cpu': cpu, 'subtype': subtype, 'fileType': filetype, 'sections': sections})
    return facts


def signature(commands, path):
    p = commands.run(['codesign', '-d', '--verbose=4', path])
    result = {}
    for line in (p.stdout + p.stderr).decode(errors='replace').splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('Identifier', 'TeamIdentifier', 'CDHash'):
            result[key] = value
    return result


def entitlements(commands, path):
    raw = commands.run(['codesign', '-d', '--entitlements', '-', '--xml', path]).stdout
    start, end = raw.find(b'<?xml'), raw.find(b'</plist>')
    require(start >= 0 or not raw.strip(), 'invalid-entitlements', '签名 entitlement 不能解析')
    return plistlib.loads(raw[start:end + 8]) if start >= 0 else {}


def code_inventory(root, main, allow_embedded=False):
    objects, executables = {}, {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not path.is_dir():
            continue
        if path.suffix in ('.app', '.appex', '.xctest') and path != main and not allow_embedded:
            raise Blocked('embedded-target-needs-profile', '个人快速模式不保留嵌入 App/扩展；已有授权时加 --strip-extensions：' + str(path))
        if path == main or path.suffix in ('.framework', '.bundle') or (allow_embedded and path.suffix in ('.app', '.appex', '.xctest')):
            info_path = path / 'Info.plist'
            if not info_path.exists():
                require(path.suffix == '.bundle', 'invalid-code-bundle', '代码组件缺少 Info.plist：' + str(path))
                continue
            info = plistlib.loads(info_path.read_bytes())
            executable = info.get('CFBundleExecutable')
            if not executable:
                require(path.suffix == '.bundle', 'invalid-code-bundle', '代码组件缺少可执行文件：' + str(path))
                continue
            binary = (path / executable).resolve()
            require(binary.is_relative_to(path.resolve()) and binary.is_file(), 'invalid-code-bundle', '可执行文件不存在或越界')
            key, binary_key = path.relative_to(root).as_posix(), binary.relative_to(root).as_posix()
            objects[key] = {'path': key, 'binary': binary_key, 'bundleId': info.get('CFBundleIdentifier'), 'kind': 'app' if path == main else 'library'}
            executables[binary_key] = key
    machos = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not path.is_file():
            continue
        facts = macho_sections(path)
        if facts is None:
            continue
        rel = path.relative_to(root).as_posix()
        machos[rel] = facts
        if rel not in executables:
            require(all(f['fileType'] in (6, 8) for f in facts), 'unsupported-executable', '发现未归属的嵌入可执行程序：' + rel)
            objects[rel] = {'path': rel, 'binary': rel, 'bundleId': None, 'kind': 'library'}
    require(set(executables) <= set(machos), 'invalid-code-bundle', '代码组件不是有效 Mach-O')
    return sorted(objects.values(), key=lambda x: (-len(PurePosixPath(x['path']).parts), x['path'])), machos


def remove_extensions(root, main, allowed):
    targets = []
    for path in main.rglob('*'):
        if path.is_symlink() or not path.is_dir() or path.suffix not in ('.app', '.appex'):
            continue
        rel = path.relative_to(main)
        require(rel.parts[0] in ('PlugIns', 'Watch', 'AppClips'), 'unsupported-embedded-target',
                '发现标准扩展目录之外的嵌入程序：' + str(rel))
        targets.append(path)
    require(not targets or allowed, 'extensions-authorization-needed',
            '包内有嵌入扩展；已有裁剪授权时加 --strip-extensions', [str(p.relative_to(root)) for p in targets])
    top = [p for p in targets if not any(a in targets for a in p.parents)]
    removed = []
    for path in sorted(top):
        removed.append(path.relative_to(root).as_posix())
        shutil.rmtree(path)
    return removed


def verify_codes(commands, root, main, objects, profile, certificate, expected_entitlements, evidence):
    results = []
    for i, obj in enumerate(objects):
        path = root / obj['path']
        commands.run(['codesign', '--verify', '--strict', path])
        sig = signature(commands, path)
        expected_id = expected_entitlements['application-identifier'][len(profile['prefix']) + 1:] if path == main else obj['identifier']
        require(sig.get('TeamIdentifier') == profile['team'] and sig.get('Identifier') == expected_id,
                'signature-mismatch', '组件 Team 或签名标识不符：' + obj['path'])
        expected = expected_entitlements if path == main else {}
        require(entitlements(commands, path) == expected, 'entitlement-mismatch', '组件 entitlement 不符：' + obj['path'])
        prefix = evidence / ('certificate-' + str(i) + '-')
        commands.run(['codesign', '-d', '--extract-certificates=' + str(prefix), path])
        leaf = Path(str(prefix) + '0')
        require(leaf.is_file() and digest(leaf, 'sha1').upper() == certificate['sha1'],
                'certificate-mismatch', '组件叶证书不符：' + obj['path'])
        for certificate_file in evidence.glob(prefix.name + '*'):
            certificate_file.unlink()
        results.append({'path': obj['path'], 'identifier': expected_id, 'teamId': profile['team'], 'strictVerification': True})
    embedded = main / 'embedded.mobileprovision'
    require(digest(embedded) == profile['sha256'], 'profile-mismatch', '嵌入 profile 与所选文件不同')
    info = plistlib.loads((main / 'Info.plist').read_bytes())
    require(info['CFBundleIdentifier'] == expected_entitlements['application-identifier'][len(profile['prefix']) + 1:],
            'bundle-id-mismatch', '主 Bundle ID 不匹配')
    return results


def report(work, state, commands):
    save_json(work / 'result.json', state)
    save_json(work / 'commands.json', commands.records)
    lines = ['# IPA 重签与安装报告', '', '状态：' + state.get('status', '未知'), '',
             '- 输入：`' + str(state.get('source', '')) + '`',
             '- 产物：`' + str(state.get('output', {}).get('path', '尚无')) + '`',
             '- Bundle ID：`' + str(state.get('bundleId', '尚未选择')) + '`',
             '- profile 到期：' + str(state.get('profile', {}).get('expiresAt', '未知')),
             '- 删除的扩展：' + json.dumps(state.get('removedExtensions', []), ensure_ascii=False),
             '- 移除的主权限键：' + json.dumps(state.get('removedEntitlementKeys', []), ensure_ascii=False),
             '- 主配置修改：' + json.dumps(state.get('metadataChanges', []), ensure_ascii=False),
             '- 只读输入验签通过数：' + str(state.get('inputSignatureCount', '未单独执行只读检查')),
             '- 严格验签通过数：' + str(len(state.get('verification', []))),
             '- 实际安装状态：' + state.get('installation', {}).get('status', '未安装'), '',
             '签名成功与安装成功均不代表启动、登录或业务正常；本工具不自动启动应用。', '',
             '完整资源基线在修改前保存；可执行文件单独对比 Mach-O section 散列。未修改输入 IPA，未导出私钥。']
    if state.get('failure'):
        lines += ['', '阻塞：' + json.dumps(state['failure'], ensure_ascii=False)]
    (work / '执行报告.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def new_work(parent, prefix='ipa-resign-'):
    parent = Path(parent).expanduser().resolve()
    require(parent.is_dir(), 'missing-work-root', '工作目录父路径不存在：' + str(parent))
    work = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
    (work / 'evidence').mkdir()
    return work


def perform_install(commands, work, state, selector, replace):
    attempt = Path(tempfile.mkdtemp(prefix='install-', dir=work))
    device = resolve_device(commands, attempt, selector)
    output = state['output']
    package = Path(output['path'])
    require(digest(package) == output['sha256'], 'output-changed', '待安装 IPA 的 SHA256 发生变化')
    root = work / 'verified'
    main = root / state['mainApp']
    require(tree_manifest(root) == json.loads((work / 'after-tree.json').read_text()),
            'output-changed', '待安装 .app 与重新解包验证的清单不一致')
    profile = read_profile(commands, main / 'embedded.mobileprovision')
    require(profile['created'] <= dt.datetime.now(UTC) < profile['expires'], 'profile-expired', '安装包描述文件已过期或尚未生效')
    require(device['udid'] in profile['devices'], 'device-not-provisioned', '安装包未覆盖选定设备')
    require(state['certificate']['sha1'] in identities(commands), 'missing-identity', '签名身份已不可用')
    objects, sections = code_inventory(root, main)
    for obj in objects:
        obj['identifier'] = signature(commands, root / obj['path'])['Identifier']
    verify_codes(commands, root, main, objects, profile, state['certificate'], state['entitlements'], attempt)
    before = commands.device(['device', 'info', 'apps', '--device', device['id']], attempt, 'apps-before.json')
    existing = [a for a in before.get('apps', []) if a.get('bundleIdentifier', a.get('bundleId')) == state['bundleId']]
    require(not existing or replace, 'replacement-authorization-needed', '设备上已有同标识应用；已获覆盖授权时加 --replace',
            [{k: a.get(k) for k in ('name', 'bundleIdentifier', 'version', 'bundleVersion')} for a in existing])
    installation = {'status': '正在安装', 'deviceName': device['name'], 'deviceId': device['id'],
                    'model': device.get('marketingName'), 'replacedExistingApp': bool(existing),
                    'evidence': str(attempt)}
    if state.get('installation'):
        state.setdefault('installationHistory', []).append(state['installation'])
    state['installation'] = installation
    try:
        result = commands.device(['device', 'install', 'app', '--device', device['id'], main], attempt, 'install.json', timeout=180)
        require(any(x.get('bundleID') == state['bundleId'] for x in result.get('installedApplications', [])),
                'install-unconfirmed', '安装服务回执中没有目标应用')
        after = commands.device(['device', 'info', 'apps', '--device', device['id']], attempt, 'apps-after.json')
        matches = [a for a in after.get('apps', []) if a.get('bundleIdentifier', a.get('bundleId')) == state['bundleId']]
        require(len(matches) == 1 and str(matches[0].get('bundleVersion')) == str(state['version']['build']),
                'install-unconfirmed', '设备应用清单未唯一匹配预期 Bundle ID/构建号')
    except Exception as error:
        installation.update({'status': '安装失败或未能确认', 'failure': failure_details(error)})
        raise
    installation.update({'status': '安装成功，未启动', 'version': matches[0].get('version'),
                         'build': matches[0].get('bundleVersion'), 'completedAt': dt.datetime.now(UTC).isoformat()})
    return installation


def do_resign(args, commands):
    source = Path(args.ipa).expanduser().resolve()
    require(source.is_file(), 'missing-ipa', 'IPA 不存在：' + str(source))
    output = Path(args.output).expanduser().resolve() if args.output else source.with_name(source.stem + '-personal-signed.ipa')
    require(output != source and not output.exists(), 'output-exists', '输出不能覆盖输入或已有文件：' + str(output))
    require(output.parent.is_dir(), 'missing-output-directory', '输出目录不存在')
    work = new_work(args.work_root or output.parent)
    state = {'schema': 'ios-ipa-resign.v1', 'source': str(source), 'workdir': str(work), 'status': '检查中'}
    try:
        state['sourceBefore'] = stamp(source)
        root = work / 'extracted'
        validate_zip(source, root)
        commands.run(['ditto', '-x', '-k', source, root], timeout=240)
        tree_manifest(root)
        mains = list((root / 'Payload').glob('*.app'))
        require(len(mains) == 1 and not mains[0].is_symlink(), 'invalid-ipa', 'Payload 中必须有唯一主 App')
        main = mains[0]
        info_path = main / 'Info.plist'
        raw_info = info_path.read_bytes()
        info = plistlib.loads(raw_info)
        state['mainApp'] = main.relative_to(root).as_posix()
        state['originalBundleId'] = info['CFBundleIdentifier']
        state['version'] = {'short': info.get('CFBundleShortVersionString'), 'build': info.get('CFBundleVersion')}
        device = resolve_device(commands, work / 'evidence', args.device) if args.device or args.install else None
        profile, bundle, certificate = choose_material(commands, args, info['CFBundleIdentifier'], device)
        state['profile'] = profile_public(profile, device)
        state['certificate'] = {'sha1': certificate['sha1'], 'expiresAt': certificate['notAfter'].isoformat()}
        state['bundleId'] = bundle
        expected_entitlements = minimal_entitlements(profile, bundle)
        state['entitlements'] = expected_entitlements
        state['removedEntitlementKeys'] = sorted(set(entitlements(commands, main)) - set(expected_entitlements))
        before = tree_manifest(root)
        save_json(work / 'before-tree.json', before)
        state['removedExtensions'] = remove_extensions(root, main, args.strip_extensions) if not args.inspect_only else []
        if args.inspect_only:
            source_objects, source_sections = code_inventory(root, main, allow_embedded=True)
            for obj in source_objects:
                commands.run(['codesign', '--verify', '--strict', root / obj['path']])
            state['inputSignatureCount'] = len(source_objects)
            state['inputMachOCount'] = len(source_sections)
            state['embeddedTargets'] = [str(p.relative_to(main)) for p in main.rglob('*') if not p.is_symlink() and p.is_dir() and p.suffix in ('.app', '.appex', '.xctest')]
            state['status'] = '只读检查完成，未重签或安装'
            return work, state
        objects, original_sections = code_inventory(root, main)
        for obj in objects:
            path = root / obj['path']
            commands.run(['codesign', '--verify', '--strict', path])
            obj['identifier'] = signature(commands, path)['Identifier']
        save_json(work / 'before-sections.json', original_sections)
        info['CFBundleIdentifier'] = bundle
        changes = []
        if bundle != state['originalBundleId']:
            changes.append({'key': 'CFBundleIdentifier', 'before': state['originalBundleId'], 'after': bundle})
        if info.get('UIApplicationShortcutWidget'):
            changes.append({'key': 'UIApplicationShortcutWidget', 'removed': info.pop('UIApplicationShortcutWidget')})
        state['metadataChanges'] = changes
        info_path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY if raw_info.startswith(b'bplist') else plistlib.FMT_XML, sort_keys=False))
        require(digest(Path(profile['path'])) == profile['sha256'], 'profile-changed', '签名前 profile 已变化')
        shutil.copyfile(profile['path'], main / 'embedded.mobileprovision')
        entitlement_file = work / 'entitlements.plist'
        entitlement_file.write_bytes(plistlib.dumps(expected_entitlements))
        for obj in objects:
            if obj['kind'] == 'app':
                continue
            commands.run(['codesign', '--force', '--sign', certificate['sha1'], '--timestamp=none',
                          '--identifier', obj['identifier'], root / obj['path']])
        commands.run(['codesign', '--force', '--sign', certificate['sha1'], '--timestamp=none',
                      '--identifier', bundle, '--entitlements', entitlement_file, main])
        verify_codes(commands, root, main, objects, profile, state['certificate'], expected_entitlements, work / 'evidence')
        _, signed_sections = code_inventory(root, main)
        require(signed_sections == original_sections, 'macho-sections-changed', '签名之外的 Mach-O section 内容发生变化')
        state['machoSectionsUnchanged'] = True
        after = tree_manifest(root)
        allowed_files = set(original_sections) | {state['mainApp'] + '/Info.plist', state['mainApp'] + '/embedded.mobileprovision'}
        signature_prefixes = [o['path'] + '/_CodeSignature/' for o in objects if (root / o['path']).is_dir()]
        changed = []
        for rel in sorted(set(before) | set(after)):
            if before.get(rel) == after.get(rel):
                continue
            allowed = rel in allowed_files or any(rel.startswith(p) for p in signature_prefixes) or any(rel.startswith(p + '/') for p in state['removedExtensions'])
            require(allowed, 'unexpected-resource-change', '发现重签范围之外的资源变更：' + rel)
            changed.append(rel)
        state['changedFiles'] = changed
        save_json(work / 'after-tree.json', after)
        candidate = work / 'candidate.ipa'
        commands.run(['ditto', '-c', '-k', root, candidate], timeout=240)
        verified = work / 'verified'
        validate_zip(candidate, verified)
        commands.run(['ditto', '-x', '-k', candidate, verified], timeout=240)
        require(tree_manifest(verified) == after, 'repack-mismatch', '重新解包后文件、权限或符号链接不一致')
        verified_main = verified / state['mainApp']
        state['verification'] = verify_codes(commands, verified, verified_main, objects, profile, state['certificate'], expected_entitlements, work / 'evidence')
        _, repacked_sections = code_inventory(verified, verified_main)
        require(repacked_sections == original_sections, 'repack-mismatch', '重新解包后的 Mach-O section 发生变化')
        state['sourceAfter'] = stamp(source)
        require(state['sourceAfter'] == state['sourceBefore'], 'source-changed', '输入 IPA 的 SHA256、大小或修改时间发生变化')
        # 先在目标磁盘写完临时文件，再排他发布，避免暴露未复制完成的 IPA。
        handle, temporary_name = tempfile.mkstemp(prefix='.ipa-output-', dir=output.parent)
        temporary = Path(temporary_name)
        try:
            with candidate.open('rb') as src, os.fdopen(handle, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
                dst.flush()
                os.fsync(dst.fileno())
            require(digest(temporary) == digest(candidate), 'publication-mismatch', '输出临时文件与候选 IPA 不一致')
            os.link(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
        state['output'] = {'path': str(output), 'sha256': digest(output), 'sizeBytes': output.stat().st_size}
        require(state['output']['sha256'] == digest(candidate), 'publication-mismatch', '发布后的 IPA 与已验证候选不一致')
        state['status'] = '重签及重新打包验签成功'
        report(work, state, commands)
        if args.install:
            perform_install(commands, work, state, device['id'], args.replace)
            state['status'] = '重签与安装成功，未启动'
        return work, state
    except Exception as error:
        state['status'] = '已停止'
        state['failure'] = failure_details(error)
        if isinstance(error, Blocked):
            error.details = {'workdir': str(work), 'report': str(work / '执行报告.md'), 'evidence': error.details}
            raise
        raise Blocked('unexpected-error', str(error), {'workdir': str(work), 'report': str(work / '执行报告.md')}) from error
    finally:
        report(work, state, commands)


def failure_details(error):
    return {'reason': error.reason if isinstance(error, Blocked) else 'unexpected-error',
            'message': str(error), 'details': error.details if isinstance(error, Blocked) else None}


def do_inventory(args, commands):
    folder = new_work(args.work_root or (Path.home() / 'Downloads'), 'ipa-inventory-')
    try:
        device = resolve_device(commands, folder / 'evidence', args.device) if args.device else None
        fingerprints = identities(commands)
        return {'workdir': str(folder), 'status': '只读材料清单',
                'devices': [{k: x[k] for k in ('id', 'name', 'model', 'state', 'transport')}
                            for x in list_devices(commands, folder / 'evidence')],
                'validIdentityFingerprints': sorted(fingerprints),
                'profiles': [profile_public(p, device) for p in all_profiles(commands)]}
    finally:
        save_json(folder / 'commands.json', commands.records)


def do_prepare(args, commands):
    work = new_work(args.work_root or (Path.home() / 'Downloads'), 'ipa-profile-')
    device = resolve_device(commands, work / 'evidence', args.device)
    profile = read_profile(commands, Path(args.profile).expanduser().resolve())
    require('*' not in profile['pattern'] and profile['entitlements'].get('get-task-allow') is True,
            'explicit-profile-required', '准备工程需要已有显式个人开发 profile，不能借通配或发布文件创建其他 App ID')
    valid = identities(commands)
    now = dt.datetime.now(UTC)
    matched = []
    for certificate in profile['certificates']:
        fp = hashlib.sha1(certificate).hexdigest().upper()
        if fp in valid:
            fact = certificate_fact(commands, certificate, profile['team'])
            if fact['notBefore'] <= now < fact['notAfter']:
                matched.append(fp)
    require(matched, 'missing-identity', '既有描述文件没有匹配的有效本机身份')
    xcodegen = shutil.which('xcodegen')
    require(xcodegen, 'missing-xcodegen', '准备隔离工程需要本机 xcodegen；未安装或升级任何工具')
    project_dir = work / 'ProfileRepair'
    project_dir.mkdir()
    source = '#import <UIKit/UIKit.h>\n// 仅用于更新已有应用描述文件，不安装此辅助 App。\nint main(int argc, char **argv) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, nil); } }\n'
    (project_dir / 'main.m').write_text(source)
    spec = {'name': 'IpaProfileRepair', 'options': {'deploymentTarget': {'iOS': '15.0'}},
            'settings': {'base': {'DEVELOPMENT_TEAM': profile['team'], 'CODE_SIGN_STYLE': 'Automatic',
                'CODE_SIGN_IDENTITY': 'Apple Development', 'PRODUCT_BUNDLE_IDENTIFIER': profile['pattern'],
                'GENERATE_INFOPLIST_FILE': 'YES', 'TARGETED_DEVICE_FAMILY': '1,2',
                'CURRENT_PROJECT_VERSION': '1', 'MARKETING_VERSION': '1.0'}},
            'targets': {'IpaProfileRepair': {'type': 'application', 'platform': 'iOS', 'sources': ['main.m']}},
            'schemes': {'IpaProfileRepair': {'build': {'targets': {'IpaProfileRepair': 'all'}}, 'run': {'config': 'Debug'}}}}
    save_json(project_dir / 'project.json', spec)
    commands.run([xcodegen, 'generate', '--spec', project_dir / 'project.json'])
    result = {'status': '仅准备工程，尚未创建描述文件或登记设备', 'workdir': str(work),
              'workdirTag': work.name, 'project': str(project_dir / 'IpaProfileRepair.xcodeproj'),
              'scheme': 'IpaProfileRepair', 'configuration': 'Debug',
              'destination': 'platform=iOS,id=' + device['udid'],
              'device': {'id': device['id'], 'name': device['name']}, 'profile': profile_public(profile, device)}
    save_json(work / 'prepared-project.json', result)
    save_json(work / 'commands.json', commands.records)
    return result


def main():
    parser = argparse.ArgumentParser(description='使用本机个人开发身份重签已有 IPA；所有副作用由显式子命令和参数选择。')
    sub = parser.add_subparsers(dest='command', required=True)
    inventory = sub.add_parser('inventory', help='只读列出本机有效身份、profile 和实体设备')
    inventory.add_argument('--device')
    inventory.add_argument('--work-root')
    resign = sub.add_parser('resign', help='重签、验证、打包，可选安装')
    resign.add_argument('--ipa', required=True)
    resign.add_argument('--personal-minimal', action='store_true', required=True, help='已选择最小个人开发权限、允许主 ID 和钥匙串组调整')
    resign.add_argument('--strip-extensions', action='store_true', help='已允许移除不兼容的标准嵌入扩展')
    resign.add_argument('--profile')
    resign.add_argument('--bundle-id')
    resign.add_argument('--team')
    resign.add_argument('--identity', help='已存在于钥匙串和 profile 中的证书 SHA1')
    resign.add_argument('--device')
    resign.add_argument('--output')
    resign.add_argument('--work-root')
    resign.add_argument('--install', action='store_true')
    resign.add_argument('--replace', action='store_true', help='已有同标识应用覆盖授权')
    resign.add_argument('--inspect-only', action='store_true', help='仅解包检查与材料匹配，不修改副本或签名')
    install = sub.add_parser('install', help='安装此前已验证的产物，不重新重签')
    install.add_argument('--result', required=True)
    install.add_argument('--device', required=True)
    install.add_argument('--replace', action='store_true')
    prepare = sub.add_parser('prepare-profile', help='准备单 App 隔离工程，不修改账号、Portal 或设备')
    prepare.add_argument('--profile', required=True)
    prepare.add_argument('--device', required=True)
    prepare.add_argument('--work-root')
    args = parser.parse_args()
    commands = Commands()
    try:
        require(sys.platform == 'darwin', 'unsupported-platform', '本工具需要 macOS 与 Xcode')
        if args.command == 'inventory':
            result = do_inventory(args, commands)
        elif args.command == 'prepare-profile':
            result = do_prepare(args, commands)
        elif args.command == 'resign':
            require(not (args.inspect_only and args.install), 'invalid-arguments', '只读检查不能同时安装')
            work, state = do_resign(args, commands)
            result = summary(work, state)
        else:
            result_file = Path(args.result).expanduser().resolve()
            work = result_file.parent
            state = json.loads(result_file.read_text())
            require(state.get('schema') == 'ios-ipa-resign.v1' and state.get('output') and state.get('verification'),
                    'invalid-result', '这不是本工具产生的已验证重签结果')
            try:
                perform_install(commands, work, state, args.device, args.replace)
                state.pop('failure', None)
                state['status'] = '重签与安装成功，未启动'
            except Exception as error:
                state['failure'] = failure_details(error)
                state['status'] = '安装已停止，已验证的重签产物保留'
                raise
            finally:
                prior_path = work / 'commands.json'
                prior = json.loads(prior_path.read_text()) if prior_path.exists() else []
                commands.records = prior + commands.records
                report(work, state, commands)
            result = summary(work, state)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({'status': 'blocked', **failure_details(error)}, ensure_ascii=False, indent=2))
        return 2


def summary(work, state):
    return {'status': state['status'], 'workdir': str(work), 'report': str(work / '执行报告.md'),
            'output': state.get('output'), 'bundleId': state.get('bundleId'), 'profile': state.get('profile'),
            'strictVerificationCount': len(state.get('verification', [])),
            'inputSignatureCount': state.get('inputSignatureCount'), 'inputMachOCount': state.get('inputMachOCount'),
            'machoSectionsUnchanged': state.get('machoSectionsUnchanged'),
            'removedExtensions': state.get('removedExtensions', []), 'installation': state.get('installation')}


if __name__ == '__main__':
    raise SystemExit(main())
