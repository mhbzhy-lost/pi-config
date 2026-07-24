# Token Stats 菜单栏工具 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 macOS 菜单栏常驻工具，展示 1d/7d/30d 的 token 消耗量和 cache hit rate，点击弹出悬浮窗查看详情。

**Architecture:** Swift Package 可执行文件，使用 SwiftUI `MenuBarExtra` 实现菜单栏图标 + popover。数据层（SessionParser / StatsAggregator）与 UI 层分离，数据层可单元测试。定时轮询 `var/sessions/*.jsonl` 刷新统计。

**Tech Stack:** Swift 6, SwiftUI (MenuBarExtra), Swift Package Manager, XCTest

---

## 文件结构

```
tools/token-stats/
├── Package.swift
├── Sources/
│   ├── TokenStatsKit/              # 可测试的数据层
│   │   ├── Models.swift            # 数据模型 (TurnUsage, ModelStats, PeriodStats)
│   │   ├── SessionParser.swift     # 解析 JSONL session 文件
│   │   └── StatsAggregator.swift   # 按时间窗口聚合统计
│   └── TokenStatsApp/              # SwiftUI 菜单栏应用
│       ├── TokenStatsApp.swift     # App 入口 + MenuBarExtra
│       ├── StatsViewModel.swift    # 定时刷新 ViewModel
│       └── StatsPopoverView.swift  # 悬浮窗 UI（分段选择器 + 统计表格）
├── Tests/
│   └── TokenStatsKitTests/
│       ├── SessionParserTests.swift
│       └── StatsAggregatorTests.swift
└── scripts/
    └── install-launch-agent.sh     # 安装 LaunchAgent 实现开机自启
```

---

### Task 1: 数据模型与 Session 解析器

**Files:**
- Create: `tools/token-stats/Package.swift`
- Create: `tools/token-stats/Sources/TokenStatsKit/Models.swift`
- Create: `tools/token-stats/Sources/TokenStatsKit/SessionParser.swift`
- Create: `tools/token-stats/Tests/TokenStatsKitTests/SessionParserTests.swift`

- [ ] **Step 1: 创建 Package.swift**

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TokenStats",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "TokenStatsKit", targets: ["TokenStatsKit"]),
        .executable(name: "TokenStats", targets: ["TokenStatsApp"]),
    ],
    targets: [
        .target(name: "TokenStatsKit"),
        .executableTarget(name: "TokenStatsApp", dependencies: ["TokenStatsKit"]),
        .testTarget(name: "TokenStatsKitTests", dependencies: ["TokenStatsKit"]),
    ]
)
```

- [ ] **Step 2: 编写 SessionParser 失败测试**

```swift
import Testing
@testable import TokenStatsKit

@Test func parseAssistantTurnWithUsage() throws {
    let jsonl = """
    {"message":{"role":"user","content":"hi"}}
    {"message":{"role":"assistant","provider":"anthropic-idealab","model":"claude-opus-4-6","usage":{"input":100,"output":50,"cacheRead":200,"cacheWrite":30,"reasoning":10,"totalTokens":390}}}
    """
    let turns = SessionParser.parse(jsonl: jsonl)
    #expect(turns.count == 1)
    #expect(turns[0].provider == "anthropic-idealab")
    #expect(turns[0].model == "claude-opus-4-6")
    #expect(turns[0].input == 100)
    #expect(turns[0].cacheRead == 200)
    #expect(turns[0].cacheWrite == 30)
    #expect(turns[0].output == 50)
}

@Test func skipNonAssistantAndMissingUsage() throws {
    let jsonl = """
    {"message":{"role":"user","content":"hi"}}
    {"message":{"role":"assistant","provider":"x","model":"y"}}
    {"type":"system","content":"ignore"}
    """
    let turns = SessionParser.parse(jsonl: jsonl)
    #expect(turns.isEmpty)
}

@Test func parseSessionFilenameTimestamp() throws {
    let name = "2026-07-14T13-54-22-083Z_019f60e8-4303-7e9c-876b-9b6cf7bbdbf5.jsonl"
    let ts = SessionParser.timestamp(fromFilename: name)
    #expect(ts != nil)
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd tools/token-stats && swift test 2>&1 | tail -5`
Expected: 编译失败，`SessionParser` 未定义

- [ ] **Step 4: 实现 Models.swift 和 SessionParser.swift**

```swift
// Models.swift
import Foundation

public struct TurnUsage: Sendable {
    public let provider: String
    public let model: String
    public let input: Int
    public let output: Int
    public let cacheRead: Int
    public let cacheWrite: Int
    public let reasoning: Int
    public let timestamp: Date?
}

// SessionParser.swift
import Foundation

public enum SessionParser {
    public static func parse(jsonl: String) -> [TurnUsage] { ... }
    public static func timestamp(fromFilename name: String) -> Date? { ... }
    public static func loadSessions(from dir: URL, since cutoff: Date) -> [TurnUsage] { ... }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd tools/token-stats && swift test`
Expected: All tests passed

- [ ] **Step 6: Commit**

```bash
git add tools/token-stats/
git commit -m "feat(token-stats): add session parser with tests"
```

---

### Task 2: 统计聚合器

**Deps:** Task 1

**Files:**
- Create: `tools/token-stats/Sources/TokenStatsKit/StatsAggregator.swift`
- Create: `tools/token-stats/Tests/TokenStatsKitTests/StatsAggregatorTests.swift`

- [ ] **Step 1: 编写聚合器失败测试**

```swift
import Testing
import Foundation
@testable import TokenStatsKit

@Test func aggregateByModel() throws {
    let turns = [
        TurnUsage(provider: "anthropic", model: "opus", input: 100, output: 50, cacheRead: 200, cacheWrite: 30, reasoning: 0, timestamp: nil),
        TurnUsage(provider: "anthropic", model: "opus", input: 50, output: 20, cacheRead: 100, cacheWrite: 0, reasoning: 0, timestamp: nil),
        TurnUsage(provider: "openai", model: "gpt", input: 300, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, timestamp: nil),
    ]
    let stats = StatsAggregator.aggregate(turns)
    #expect(stats.count == 2)
    let opus = stats.first { $0.key == "anthropic/opus" }!
    #expect(opus.turns == 2)
    #expect(opus.input == 150)
    #expect(opus.cacheRead == 300)
    #expect(opus.hitRate! == 300.0 / (150.0 + 300.0 + 30.0))
}

@Test func hitRateZeroWhenNoTokens() throws {
    let stats = StatsAggregator.aggregate([])
    #expect(stats.isEmpty)
}

@Test func periodFiltering() throws {
    let now = Date()
    let turns = [
        TurnUsage(provider: "a", model: "m", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, timestamp: now.addingTimeInterval(-3600)),
        TurnUsage(provider: "a", model: "m", input: 20, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, timestamp: now.addingTimeInterval(-86400 * 10)),
    ]
    let day = StatsAggregator.filter(turns, within: .day, from: now)
    #expect(day.count == 1)
    let month = StatsAggregator.filter(turns, within: .month, from: now)
    #expect(month.count == 2)
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/token-stats && swift test 2>&1 | tail -5`
Expected: 编译失败，`StatsAggregator` 未定义

- [ ] **Step 3: 实现 StatsAggregator**

```swift
import Foundation

public enum TimePeriod: String, CaseIterable, Sendable {
    case day = "1D"
    case week = "7D"
    case month = "30D"

    public var seconds: TimeInterval {
        switch self {
        case .day: 86_400
        case .week: 604_800
        case .month: 2_592_000
        }
    }
}

public struct ModelStats: Sendable {
    public let key: String
    public let turns: Int
    public let input: Int
    public let output: Int
    public let cacheRead: Int
    public let cacheWrite: Int
    public var totalTokens: Int { input + output + cacheRead + cacheWrite }
    public var hitRate: Double? {
        let denom = input + cacheRead + cacheWrite
        return denom > 0 ? Double(cacheRead) / Double(denom) : nil
    }
}

public enum StatsAggregator {
    public static func aggregate(_ turns: [TurnUsage]) -> [ModelStats] { ... }
    public static func filter(_ turns: [TurnUsage], within period: TimePeriod, from now: Date = .now) -> [TurnUsage] { ... }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/token-stats && swift test`
Expected: All tests passed

- [ ] **Step 5: Commit**

```bash
git add tools/token-stats/
git commit -m "feat(token-stats): add stats aggregator with period filtering"
```

---

### Task 3: SwiftUI 菜单栏应用

**Deps:** Task 2

**Files:**
- Create: `tools/token-stats/Sources/TokenStatsApp/TokenStatsApp.swift`
- Create: `tools/token-stats/Sources/TokenStatsApp/StatsViewModel.swift`
- Create: `tools/token-stats/Sources/TokenStatsApp/StatsPopoverView.swift`

- [ ] **Step 1: 实现 StatsViewModel（定时刷新 + 数据加载）**

```swift
import Foundation
import Observation
import TokenStatsKit

@Observable @MainActor
final class StatsViewModel {
    var selectedPeriod: TimePeriod = .day
    var allTurns: [TurnUsage] = []
    var modelStats: [ModelStats] = []
    var totalStats: ModelStats?

    private let sessionsDir: URL
    private var timer: Timer?

    init() {
        // 定位 var/sessions 目录
        sessionsDir = Self.findSessionsDir()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() { ... }
}
```

- [ ] **Step 2: 实现 TokenStatsApp 入口（MenuBarExtra）**

```swift
import SwiftUI
import TokenStatsKit

@main
struct TokenStatsApp: App {
    @State private var vm = StatsViewModel()

    var body: some Scene {
        MenuBarExtra {
            StatsPopoverView(vm: vm)
        } label: {
            // 菜单栏显示 cache hit rate
            Label(vm.hitRateLabel, systemImage: "chart.bar.fill")
        }
        .menuBarExtraStyle(.window)
    }
}
```

- [ ] **Step 3: 实现 StatsPopoverView（悬浮窗 UI）**

UI 布局：
- 顶部：分段选择器 (1D / 7D / 30D)
- 摘要行：总 tokens、cache hit rate、turns 数
- 表格：per-model 明细（model、turns、input、cached、write、hit%）
- 底部：刷新按钮 + 退出按钮

```swift
import SwiftUI
import TokenStatsKit

struct StatsPopoverView: View {
    @Bindable var vm: StatsViewModel

    var body: some View {
        VStack(spacing: 12) {
            Picker("Period", selection: $vm.selectedPeriod) {
                ForEach(TimePeriod.allCases, id: \.self) { p in
                    Text(p.rawValue).tag(p)
                }
            }
            .pickerStyle(.segmented)

            // Summary cards
            HStack { ... }

            // Per-model table
            ScrollView { ... }

            // Footer
            HStack {
                Button("Refresh") { vm.refresh() }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding()
        .frame(width: 420, height: 360)
    }
}
```

- [ ] **Step 4: 编译验证**

Run: `cd tools/token-stats && swift build`
Expected: Build complete

- [ ] **Step 5: 手动运行验证 UI**

Run: `cd tools/token-stats && swift run TokenStats`
Expected: 菜单栏出现图标，点击弹出悬浮窗显示统计数据

- [ ] **Step 6: Commit**

```bash
git add tools/token-stats/
git commit -m "feat(token-stats): add menu bar app with popover UI"
```

---

### Task 4: LaunchAgent 安装脚本

**Deps:** Task 3

**Files:**
- Create: `tools/token-stats/scripts/install-launch-agent.sh`

- [ ] **Step 1: 编写安装脚本**

```bash
#!/bin/bash
# 编译 release 版本并安装为 LaunchAgent（开机自启）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/.build/release"
APP_NAME="TokenStats"
PLIST="$HOME/Library/LaunchAgents/com.pi.token-stats.plist"

echo "Building release..."
cd "$PROJECT_DIR" && swift build -c release

echo "Installing LaunchAgent..."
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.pi.token-stats</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BUILD_DIR}/${APP_NAME}</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Done. TokenStats is running in menu bar."
```

- [ ] **Step 2: 验证脚本可执行**

Run: `chmod +x tools/token-stats/scripts/install-launch-agent.sh && bash -n tools/token-stats/scripts/install-launch-agent.sh`
Expected: 语法检查通过

- [ ] **Step 3: Commit**

```bash
git add tools/token-stats/
git commit -m "feat(token-stats): add LaunchAgent install script"
```
