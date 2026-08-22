# Changelog

## [Unreleased]
### BREAKING CHANGES
- **scene-steps 节点 failBehavior 默认值**: 由 `stop` 改为 `skip`。旧 flows.json 中未显式设 `failBehavior` 的 scene-steps 节点,重新部署后运行时行为从"失败即中止"变为"失败即跳过当前步继续"。如需保持原中止行为,请在编辑器「高级选项」折叠面板中显式设为 `stop`。
- **scene-steps 节点 sceneId 只读化**: 编辑器顶部移除「场景 ID」输入框与🎲生成按钮,sceneId 在节点首次保存时自动生成,之后保持只读。旧 flows.json 中已手填的 sceneId 保留原值继续生效;如确需改 sceneId,只能通过 flows.json 文本编辑(运维操作)。

### Features
- scene-steps 编辑器顶部布局简化:三栏(动作库/步骤列表/属性配置)高度撑满 tray,顶部栅格只剩「名称」1 个可见字段,失败策略/默认步骤超时/跳转循环上限收纳进「高级选项」折叠面板(默认收起,非默认值时显示「已自定义 N」橙色徽章)。
- scene-steps 编辑器宽度记忆:首次打开撑满视口 92%,拖拽改宽后关闭重开自动恢复(localStorage 持久化,跨会话生效)。
