# Bug: Compat runtime 测试错误期待恢复外层 broker marker

## 症状

`binds the installed supervisor runtime behind project-owned tools`在普通clean shell中通过，但从已启用Root broker的Pi session运行时稳定失败：shutdown后实际`PI_ROOT_SUBAGENT_BROKER_ENABLED`为`undefined`，测试却期待外层继承值`"1"`。

## 影响

flat runtime compat矩阵固定为26/27，Todo `#53`无法关闭，并把测试隔离错误误报成persisted-session runtime未启动。真实Root broker启动、工具注册与shutdown恢复行为本身正常。

## 复现

1. 测试开始前环境已有`PI_ROOT_SUBAGENT_BROKER_ENABLED=1`。
2. 测试保存该外层值，然后主动删除全部subagent markers以创建隔离runtime。
3. Runtime启动前看到marker缺失，正确记录`previousBrokerMarker=undefined`；shutdown后也正确恢复为`undefined`。
4. 测试却把shutdown结果与删除前保存的外层`"1"`比较，得到`undefined !== "1"`；最外层finally随后才恢复原环境。

## 根因

测试混用了两层基线：资源隔离finally需要恢复“进入测试前”的外层环境，而runtime shutdown断言必须比较“启动runtime前、已清理”的内层环境。两者错误复用同一个`previousMarkers`。

## 修复

删除markers后记录独立的runtime baseline，shutdown断言只与该内层baseline比较；最外层finally继续使用原`previousMarkers`恢复调用者环境。不得修改production marker ownership或shutdown顺序。

## 验证

同一focused测试分别在broker marker未设置和预设为`1`的环境运行，均通过；预设场景结束后外层marker仍为`1`。再运行完整`pi-subagents-compat.test.mjs`，确认原唯一失败消失且其他compat断言不变。
