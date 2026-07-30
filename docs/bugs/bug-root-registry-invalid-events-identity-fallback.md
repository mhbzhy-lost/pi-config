# Bug: Root registry 对无效 events identity 静默降级

## 症状

Root broker registry以`pi.events`作为跨extension的canonical key，但当某个ExtensionAPI暴露`events: null`、primitive或错误代理值时，当前实现静默回退到该extension私有的`pi`对象。Runtime可能已按合法event bus绑定，Launcher却按私有API对象查询并再次报`Root subagent broker is unavailable`。

## 影响

错误或不兼容的ExtensionAPI包装会重新引入跨模块registry分裂，也可能让同一Root runtime绕过duplicate bind检查。真实Pi 0.83提供稳定对象型event bus，不会触发，但边界当前没有fail-closed保证。

## 复现

1. 用API A的对象型`events`绑定broker。
2. 用API B模拟同一runtime，但把`events`包装成`null`或字符串。
3. 当前`registryKey`对B回退到API B对象，`requireRootBroker(B)`返回unavailable，而不是拒绝无效canonical identity。
4. 若`events`是每次读取返回不同对象的accessor，`bindRootBroker`的`has`和`set`两次读取还可能使用不同key。

## 根因

`registryKey`把“字段缺失的旧测试double”和“字段存在但合同无效”混为同一种fallback；`bindRootBroker`又重复计算key。canonical identity的验证与使用没有形成一次性边界。

## 修复

仅当`events`字段完全不存在时，为旧式测试double回退到`pi`对象；字段存在时必须是非null object/function，否则明确抛错。每个公开操作只计算一次key，尤其duplicate bind的`has/set`必须复用同一对象。

## 验证

增加独立RED覆盖：两个不同API共享同一events可互见且duplicate bind；不同events隔离；存在但为null/primitive的events全部fail closed；accessor在一次bind中只读取一次。保留真实persisted-session跨Jiti测试、Root broker全套和flat Harness。
