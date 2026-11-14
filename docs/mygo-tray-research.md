# MyGo 系统托盘 / 菜单栏支持调研

调研日期：2026-11-13。项目当前固定使用 `github.com/egoist/mygo v0.9.0` 和 `mygo-runtime 0.9.0`（见仓库 `go.mod`、`package.json`）。以下优先按 v0.9.0 tag 的官方文档与示例判断；未运行托盘 GUI 验证。

## 结论

**MyGo v0.9.0 提供 Windows、macOS、Linux 共用的系统托盘 API `mygo.NewTray`。** 文档把 macOS 的位置称为菜单栏（menu bar），Windows 和 Linux 称为通知区域（notification area）。项目可以共用托盘实现，先在 macOS 验收，再在另外两种系统验证；Linux 部署必须处理 AppIndicator 系统依赖和桌面环境差异。[v0.9.0 托盘文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/menus.md#tray-icons)；[v0.9.0 API 源码](https://github.com/egoist/mygo/blob/v0.9.0/modules.go)

截至调研日，GitHub 的 latest release 为 **v0.9.0**，发布日期为 2026-11-11。以下行为结论以项目固定的 tag 文档为准。[GitHub latest release API](https://api.github.com/repos/egoist/mygo/releases/latest)；[v0.9.0 发布页](https://github.com/egoist/mygo/releases/tag/v0.9.0)

## API 和平台差异

- 在 `App.WhenReady` 中调用 `mygo.NewTray(TrayOptions{...})`。选项可设置 PNG 图标、提示文字和菜单；返回错误应被处理。带菜单时点击图标显示菜单；不带菜单时可用 `OnClick`、`OnRightClick` 处理点击。MyGo 示例按相同方式创建托盘并提供显示窗口、动作和退出菜单项。[v0.9.0 托盘文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/menus.md#tray-icons)；[v0.9.0 原生示例](https://github.com/egoist/mygo/blob/v0.9.0/examples/native/main.go)
- **macOS：** 图标位于菜单栏。文档建议约 16×16 points（高分屏用 32×32 像素）的 PNG；黑色绘制、透明底的模板图标配合 `IconIsTemplate: true`，由系统适配浅色/深色菜单栏。可用 `Tray.SetTitle` 在图标旁显示文字。菜单栏常驻型应用通常调用 `App.SetActivationPolicy(ActivationPolicyAccessory)` 隐藏 Dock 图标，窗口仍可显示。[v0.9.0 托盘文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/menus.md#tray-icons)；[v0.9.0 App 文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/app.md#the-dock-and-the-taskbar)
- **Windows：** 图标位于任务栏通知区域，用户可以决定图标显示在任务栏还是溢出区域；设置稳定 `ID` 可以保留用户的显示选择。`PopUpMenu` 在 Windows 11 将菜单放在任务栏图标上方附近；Windows 10 或溢出区域中的图标则在指针附近弹出。[v0.9.0 托盘文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/menus.md#tray-icons)
- **Linux：** MyGo 通过 AppIndicator 提供托盘，需要系统安装 `libayatana-appindicator3`；缺少库时 `NewTray` 返回错误。Debian 包名为 `libayatana-appindicator3-1`，RPM 为 `libayatana-appindicator-gtk3`，Arch 为 `libayatana-appindicator`，可通过 MyGo 的 Linux `depends` 配置声明。点击行为取决于 AppIndicator 实现：较新的库有 `activate` 信号时 `OnClick` 可接收激活；较旧版本不报告点击。GNOME 的 AppIndicator 扩展以双击触发激活，单击在双击间隔后打开菜单。模板图标根据桌面颜色偏好变白，但 AppIndicator 不能报告面板自身的主题；没有 settings portal 时 `Tray.Dark` 返回 false。[v0.9.0 托盘文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/menus.md#tray-icons)；[v0.9.0 Linux 包配置文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/distribution.md#linux)

## 常驻、关闭和回调线程

- **托盘图标本身不会让进程常驻。** MyGo 默认在最后一个窗口关闭时退出。官方建议关闭窗口时改为隐藏窗口，以保留窗口和应用；可在 `Window.OnClose` 中阻止关闭并调用 `Hide`，再从托盘菜单调用 `Show`。若托盘创建失败，应保留正常关闭路径，避免 Linux 缺库时窗口无法退出。前半部分是官方行为，失败时回退是对项目的实现建议。[v0.9.0 托盘文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/menus.md#tray-icons)；[v0.9.0 退出生命周期](https://github.com/egoist/mygo/blob/v0.9.0/docs/app.md#quitting)
- 托盘菜单使用 `RoleQuit` 可走正常退出生命周期。官方示例通过 `App.OnBeforeQuit` 设置 `quitting` 标志，再由 `OnClose` 区分用户点窗口关闭与应用主动退出。若退出可被取消，`OnQuitCanceled` 应清除该标志，避免后续关闭被误判为退出流程。[v0.9.0 托盘文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/menus.md#tray-icons)；[v0.9.0 退出文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/app.md#quitting)
- AppKit、GTK 和 Win32 的 UI 由主线程驱动。MyGo 将主 goroutine 锁在主线程；托盘及窗口事件监听器（如 `OnClose`）也在主线程运行，应该保持短小，耗时工作放到 goroutine。普通 MyGo 方法可从任意 goroutine 调用，跨线程调用会转发到主线程并等待结果；绑定服务方法则每次调用在自己的 goroutine 执行。不要在托盘回调里同步执行耗时图像或网络任务。[v0.9.0 线程约定](https://github.com/egoist/mygo/blob/v0.9.0/docs/app.md#threads)；[v0.9.0 `mygo.go`](https://github.com/egoist/mygo/blob/v0.9.0/mygo.go)

## 对 Pic Piper 的建议

建议先在 macOS 验证托盘创建、打开主窗口、关闭窗口后隐藏、通过菜单退出这条生命周期；**现有 React/WebView 主窗口可以继续使用**，托盘 API 与窗口采用 Web 页面还是 MyGo Native UI 无关。[v0.9.0 架构说明](https://github.com/egoist/mygo/blob/v0.9.0/docs/README.md) 实现时仍使用平台共用的 `NewTray` 和菜单 API，为 `NewTray` 错误保留普通窗口行为。第一版优先用菜单项实现“打开 Pic Piper / 退出”，便于三平台共享；macOS 再按产品需要决定是否隐藏 Dock 图标。之后 Windows 可沿用菜单行为；Linux 需在打包依赖中加入对应发行版的 AppIndicator 包，并在 GNOME/KDE 等实际桌面环境验证呈现与点击。

这是根据官方 API 和示例对项目适配路径的**推断/建议**，不是已实现或运行验证的结果。官方 v0.9.0 示例包括跨平台原生托盘示例和 macOS/Windows 风格菜单栏面板示例；Linux 版本用 AppIndicator 菜单项打开面板，说明不同桌面上的点击交互不能假定完全一致。[原生示例](https://github.com/egoist/mygo/blob/v0.9.0/examples/native/main.go)；[菜单栏原生示例](https://github.com/egoist/mygo/tree/v0.9.0/examples/menubar-native)

## 尚未验证

- 本调研只核对官方文档、tag 源码和示例，没有在 Windows、macOS、Linux 上实际构建或操作托盘。
- Linux 的托盘显示受 AppIndicator 库版本、发行版依赖和桌面面板/扩展影响；仅在文档中确认 MyGo 支持该 API，不代表所有 Linux 桌面默认都能显示图标。
- macOS Dock 隐藏策略、关闭窗口后重开以及 Windows 任务栏溢出行为，需在目标系统上做 GUI 验收。
