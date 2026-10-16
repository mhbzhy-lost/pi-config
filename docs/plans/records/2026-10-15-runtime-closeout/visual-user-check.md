# L3：用户终端观感一次确认卡

本卡基于已经真实运行并通过的隔离Host证据，不是像素截图，也不能代签用户观感。

## 已确定的机器事实

- 真实8场景：8/8，所有最终运行child/driver退出0、无residual。
- 三kind标题统一前缀3列，78列帧的状态右边界统一；长标题完整保留(delegate)，续行与标题对齐。
- widths20/40/78/120、rows4/10/24不崩，官方debug每行不越列。
- Alt+O/右箭头进入三kind详情；CSI-u Esc关闭后probe草稿逐字为`fixture 草稿保留`。

## 三份原始样本（只包含本测试自造数据）

1. 三类同场：
   `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/bg-visual-base-rFfdQ9/frame-base.log`
2. 中文长标题：
   `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/bg-visual-long-EeKNWQ/frame-long.log`
3. 草稿与三类detail切换：
   `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/bg-visual-draft-Ny1lLy/probe.jsonl`

同根`ansi.log`与`pty/pty-output.log`为历史ANSI流，不直接重放到用户终端，不将去ANSI后历史拼接当最终屏幕。

## 用户一次确认范围

在你实际使用的终端重新加载已提交renderer后，观察一次：

- 长标题与续行左沿一致，没有旧空槽或割裂的(delegate)；
- 三类同场时glyph、标题和状态列顺眼，不频繁跳动；
- Alt+O查看后Esc关闭，草稿、光标、中文输入法候选位置恢复；
- 深浅主题色可读，无明显闪烁/残影。

回复“这几项观感正常”即可结束L3；有问题时提供对应截图/尺寸/主题，不需要完整session或配置。

**当前状态：机器可验部分完成；L3仍pending-user。** “直接做”的执行授权不构成对未观察视觉结果的确认。不自动操纵你当前终端、不改字体、不读取桌面或其他应用。
