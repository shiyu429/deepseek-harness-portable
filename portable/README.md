# DSH Portable 构建源码

这是 DeepSeek Harness 官方 `dsh-v0.2.1-rc.5`（提交 `b830ec950faba0a46dda564be3e2d854afed94f1`）的第三方 Windows x64 便携构建。源码包中 `upstream/` 是包含便携改动的完整官方源码，`portable/` 是便携启动、Windows 固定授权、数据维护、构建和验收工具。

## 构建

在 Windows 10/11 x64 普通桌面会话中，将整个源码包放在可写的 NTFS 目录。需要网络、Windows 自带的 PowerShell 5、tar.exe 和 .NET Framework 4.8 C# 编译器；编译过程中会下载依赖，需要充足的磁盘空间。建议使用较短目录，并预留 15 GB 以上空间。

右键“使用 PowerShell 运行” `portable/scripts/Build.ps1`，或在源码包根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\portable\scripts\Build.ps1
```

`Bypass` 只用于此 PowerShell 进程，不写系统执行策略。脚本下载并校验固定 Node.js，随后将 pnpm、依赖、缓存、编译输出放在源码包内；不全局安装软件。已有 Node.js 24 时也可直接运行 `node portable/scripts/build.mjs`。

`packed-app/win-unpacked` 是内部 Electron 构建目录。构建最后将生成可交付的版本化程序目录，位置记录在 `delivery/build-result.json`。`node portable/scripts/verify-package.mjs` 校验内部打包文件及自带运行环境。用户运行便携版不需要构建所用的网络下载或编译工具。

固定输入包括 `upstream/pnpm-lock.yaml`、`upstream/scripts/primary-runtime/lock.json`、`portable/upstream.lock.json`、`portable/pnpm-yaml.lock.json`、`portable/msvc.lock.json`、`portable/extra-wheels.lock.json`、`portable/runtime-overrides.json` 和 `portable/production-pnpm-lock.yaml`。额外 Python wheel 逐项校验，npm 来自同一份锁定的官方 Node ZIP。刷新额外库需要显式运行 `scripts/capture-extra-wheels.py --refresh-lock`；普通构建冻结依赖锁。`refresh-runtime.mjs --refresh-lock` 是维护者明确修改源码后的更新操作，不用于普通重建。重建目标为相同源代码、版本和依赖集合；没有声称不同 Windows 构建环境能产生逐字节相同的 EXE/ZIP。

## 实现位置

- `runtime/bootstrap.mjs`：在官方主程序前设置数据目录和子进程环境，识别 NTFS/FAT32/exFAT 及重复启动。使用 Electron 的 ESM 顶层等待保证注册内部协议的时机。
- `runtime/core.cjs`：便携路径、持久化状态、进程数据锁、已生成依赖元数据的路径修复。聊天正文不参与路径替换。
- `native/NativeHelper.cs`：电脑及目录身份、跨账户 data 权限和进程锁；拒绝宽泛写权限及外部链接，保留私有子目录权限，补齐中断的继承授权及当前所有者所需的根目录标签设置权。没有退出恢复。
- `native/StartupWindow.cs`：先于完整性检查显示原生等待窗口，主窗口可见后关闭。
- `runtime/pnpm-portable.mjs`、`runtime/python-sitecustomize.py`：真实 Node 包管理入口、项目内缓存，以及受限令牌下 Python 私有临时目录兼容处理。FAT32/exFAT 明确显示当前账户权限。
- `native/MaintenanceEngine.cs` 与 `MaintenanceForm.cs`：统一图形维护工具；纯程序覆盖更新、更新中断续装、完整性检查和数据目录入口。旧版命令维护代码保留为非界面兼容接口。
- 官方改动位于 home-paths、workspace、working-directory、fs-local、会话接口、sandbox 及 Desktop/desktop-host；第三方 vendor 源码保持上游内容。
- 凭据提供器及凭据格式保持官方实现。没有增加加密、密码或新存储接口。

## 覆盖更新

根目录的 .NET Framework 启动器校验独立 `app/bin` 内的程序文件，再检查 `data` 的格式标识。更新包只覆盖程序及入口，不包含 `data` 或 `backups`；无需数据备份或迁移。程序版本号与数据格式标识分离。只允许相同、经过验证的数据格式；未知、损坏或不同格式的记录会阻止官方应用启动。首次从 1.1.0 覆盖时识别其已有格式，不转换会话、凭据或数据库。

`data-contract.json` 将允许的数据格式绑定到已经核对的官方提交。升级上游提交前必须审核数据读取与写入兼容性并补充测试；不能只改便携版本号或扩大允许列表。检查失败不创建缓存、不写数据；正常应用启动仍会保存运行位置与格式标识，修复受管理依赖的程序资源路径。维护中心验证切换完成后，清理可确认归属的旧程序；被占用的文件留有清理记录供重试，不复制旧用户数据。

`native/Launcher.cs` 和 `runtime/program-guard.cjs` 在执行应用前分别校验程序完整性及数据兼容性；`scripts/assemble-overwrite.mjs` 组装版本目录。覆盖中断测试使用虚构凭据，断言 `data` 文件集合和 SHA-256 保持一致。物理磁盘故障和应用运行中断电的数据恢复不在覆盖更新机制的保证内。

便携 data 根目录保护 DACL 继承，子项保留继承；Everyone/登录 SID 的宽泛允许写项被收窄，Authenticated Users 保留跨账户访问。所选电脑工作区仅使用官方授权及便携授权前检查，不添加 data 的跨账户权限。读取、网络及并发替换不属于完整隔离保证。

`tests/` 包含启动和维护组件测试；上游路径测试在 `upstream/packages/util/home-paths/tests/portable.spec.ts`，官方模式及真实 Windows 权限验收在 `scripts/check-official-sandbox.mts`。桌面模拟服务及搬移验收在 `scripts/*probe.mjs`。只使用虚构密钥。

许可与使用范围见本目录 `LICENSE`、官方 `upstream/LICENSE`、官方和各依赖的许可证。使用方法见项目主页或源码中的 `docs/使用说明.md`，成品不附带使用说明。本项目不是官方发行包。

## 公开发行

完成必要的实际检查后，运行：

```powershell
node portable/scripts/release.mjs --public --out=outputs/1.3.3
```

只生成最新完整版 ZIP 和 SHA256SUMS.txt；供 GitHub 提交的源码目录位置记录在 `delivery/public-source.json`。公开导出不携带用户 data、缓存、构建产物、内部交接文档或测试报告。正式上传前检查源码与归档清单。构建用的单元测试代码属于源码，实际机器检查记录只保存在本地。

1.3.1 的程序槽位使用短路径 `app/bin`，程序版本和完整 SHA-256 保存在清单中。维护工具持有独占锁，先保存可续装状态，再替换程序；出现中断时阻止启动并继续安装。WindowsPaths.cs 对内部文件读写添加扩展路径前缀，公开路径和子进程参数保持普通绝对路径。组件不写系统长路径策略。ZIP 顶层目录名为 DSH；构建限制最长物理相对文件路径，Windows 路径回归测试使用未声明长路径支持的旧式 Win32 解压接口。

## pnpm 搬迁回归检查

`runtime/pnpm-portable.mjs` 使用固定 YAML 解析器兼容旧 `.modules.yaml`，仅重定位已登记项目内的 storeDir/virtualStoreDir；异常文档会明确失败。`core.cjs` 桌面修复保持 pnpm 11 原生 JSON 表示，保留不相关字段。独立解析器来自冻结生产依赖，版本与完整性记录在 `pnpm-yaml.lock.json`，随包携带其许可证。

`tests/pnpm-portability.mjs` 使用真实自带 Node/pnpm、离线小包和 CLI 检查。可选 `--real-plugin` 安装 dsh-pet 0.4.0；独立夹具显式关闭 Host peer 的自动安装，不能替代实际桌面插件加载检查。`scripts/check-pnpm-fat32.ps1` 仅供管理员测试会话：新建自己拥有的 FAT32 VHD，更换两次空闲盘符并自动卸载，不选择现有磁盘。仓库的 Windows portable pnpm FAT32 工作流可手动运行，权限为空，不读取仓库凭据。VHD 验证不等于实体 U 盘或跨电脑验证。
