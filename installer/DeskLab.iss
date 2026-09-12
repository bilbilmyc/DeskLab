#ifndef AppExe
  #error AppExe must point to the compiled DeskLab.exe
#endif
#ifndef StageDir
  #error StageDir must contain installer metadata
#endif
#ifndef AppVersion
  #define AppVersion "0.1.2"
#endif

[Setup]
AppId={{8C36DACB-BD2D-4434-BE2D-3CE707423D02}
AppName=DeskLab
AppVersion={#AppVersion}
AppPublisher=DeskLab
DefaultDirName={localappdata}\Programs\DeskLab
DefaultGroupName=DeskLab
DisableDirPage=no
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputBaseFilename=DeskLab-Setup
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
SetupIconFile=DeskLab.ico
UninstallDisplayIcon={app}\DeskLab.ico
CloseApplications=no
RestartApplications=no
CreateUninstallRegKey=not IsIsolatedTest
UsePreviousAppDir=not IsIsolatedTest

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Types]
#ifdef DockerEngineDir
Name: "full"; Description: "完整安装（虚拟机和独立 Docker 引擎）"
#else
Name: "full"; Description: "标准安装（虚拟机和外部 Docker 连接）"
#endif
Name: "compact"; Description: "基础安装（虚拟机和外部 Docker 连接）"
Name: "custom"; Description: "自定义安装"; Flags: iscustom

[Components]
Name: "app"; Description: "DeskLab 主程序与虚拟化引擎"; Types: full compact custom; Flags: fixed
#ifdef DockerEngineDir
Name: "docker"; Description: "独立 Docker 引擎（预装 Linux、Docker 和 Compose）"; Types: full
#endif

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Check: not IsIsolatedTest

[Dirs]
Name: "{app}\iso"; Flags: uninsneveruninstall
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\templates"; Flags: uninsneveruninstall

[Files]
Source: "{#AppExe}"; DestDir: "{app}"; DestName: "DeskLab.exe"; Flags: ignoreversion
Source: "DeskLab.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\desklab.install.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\node-forge.LICENSE.txt"; DestDir: "{app}\licenses"; Flags: ignoreversion
Source: "{#StageDir}\builtin-catalogue.json"; DestDir: "{app}\templates"; Flags: ignoreversion uninsneveruninstall
Source: "TEMPLATES.txt"; DestDir: "{app}\templates"; DestName: "README.txt"; Flags: ignoreversion uninsneveruninstall
#ifdef DockerEngineDir
Source: "{#DockerEngineDir}\*"; DestDir: "{app}\runtime\docker-engine"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: docker
#endif

[Icons]
Name: "{autoprograms}\DeskLab"; Filename: "{app}\DeskLab.exe"; WorkingDir: "{app}"; IconFilename: "{app}\DeskLab.ico"; IconIndex: 0; Check: not IsIsolatedTest
Name: "{autodesktop}\DeskLab"; Filename: "{app}\DeskLab.exe"; WorkingDir: "{app}"; IconFilename: "{app}\DeskLab.ico"; IconIndex: 0; Tasks: desktopicon; Check: not IsIsolatedTest

[Run]
Filename: "{app}\DeskLab.exe"; WorkingDir: "{app}"; Description: "打开 DeskLab"; Flags: nowait postinstall skipifsilent; Check: not IsIsolatedTest

[Code]
function IsIsolatedTest: Boolean;
begin
  Result := ExpandConstant('{param:DESKLABTEST|0}') = '1';
end;

procedure InitializeWizard;
begin
  WizardForm.SelectDirLabel.Caption := '选择 DeskLab 的安装位置，例如 D:\apps\DeskLab。程序、ISO 安装盘和环境数据都保存在这个目录中。';
  WizardForm.FinishedLabel.Caption := 'DeskLab 已安装完成。首次使用时，在程序内选择系统并下载所需安装盘。升级或卸载程序会保留 ISO、环境和自定义模板。';
end;
