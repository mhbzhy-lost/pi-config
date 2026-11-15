#!/usr/bin/env node
// git clean filter：从 pi/settings.json 剥离 Pi 运行时/机器状态字段（lastChangelogVersion/deviceId 等）。
// 由 .gitattributes 的 filter=pi-settings-clean 触发；ensure-pi-settings 负责配置 git filter。
// 逻辑归属 src/pi-settings feature，本文件只做 stdin→stdout 的薄封装。
import { readFileSync } from "node:fs";
import { cleanSettingsText } from "../src/pi-settings/index.ts";

process.stdout.write(cleanSettingsText(readFileSync(0, "utf8")));
