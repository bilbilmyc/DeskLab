'use client';
import { useCallback, useState } from 'react';
import { Box, Layers, SlidersHorizontal, Plus, Search, ArrowUpRight, X, Monitor, Cpu, MemoryStick, ChevronRight, LoaderCircle, AlertCircle, Check, Terminal, Download, Power } from 'lucide-react';
import {version} from '../package.json';
import type { Family, Machine, Template } from '@/shared/types';
import { families } from '@/shared/types';
import { useLab } from './use-lab';
import {useDiagnostics, DiagnosticsSummary} from './diagnostics';
import { Bytes, Empty, Modal } from './primitives';
import { CreateMachine } from './create-machine';
import { MachineList } from './machine-list';
import {WorkspaceHeading} from './workspace-heading';
import { SettingsPanel } from './settings';
import { TemplateLibrary } from './template-library';
import { Desktop } from './desktop';
import {ConnectionInfo} from './connection-info';
import {DockerPanel} from './docker/panel';
import {PortsPanel} from './ports-panel';
import type {SshKeyInfo} from '@/shared/ssh';
import { TemplateFields, templateFields } from './template-fields';
import { downloading } from './iso-library';
import { useFilePicker } from './file-picker';
import type {FileListing, FilePickerKind} from '@/shared/file-picker';
type Page = 'machines' | 'templates' | 'settings' | 'docker' | 'ports';
type Confirmation = {id: string; name: string; operation: string; kind: 'machines'|'templates'};
export function Workbench() {
  const {data, error, busy, action, clearError, exited, inspectIso} = useLab();
  const diagnostics = useDiagnostics(!!data && !exited, action, JSON.stringify(data?.settings));
  const [confirmExit,setConfirmExit]=useState(false);
  const [connectionId,setConnectionId]=useState('');
  const [page, setPage] = useState<Page>('machines'), [creating, setCreating] = useState(false), [family, setFamily] = useState<Family>();
  const [initialTemplateId,setInitialTemplateId]=useState<string>();
  const [initialIsoPath,setInitialIsoPath]=useState<string>();
  const [settingsSection,setSettingsSection]=useState<'images'|'computer'>('images');
  const [initialIso,setInitialIso]=useState(false), [customizing,setCustomizing]=useState(false), [templateGroup,setTemplateGroup]=useState<'builtin'|'custom'>('builtin');
  const [machineState,setMachineState]=useState('all');
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [tabs, setTabs] = useState<string[]>([]), [active, setActive] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null), [notice, setNotice] = useState('');
  const create = (family?: Family, templateId?: string, customize = false, iso = false, isoPath?:string) => {setFamily(family);setInitialTemplateId(templateId);setInitialIsoPath(isoPath);setCustomizing(customize);setInitialIso(iso);setCreating(true);};
  const installIso=(path?:string, family?:Family)=>create(family,undefined,false,true,path);
  const invoke = (id: string, operation: string) => {void action<Machine>(`machines/${id}/${operation}`).then(vm => {if(operation==='start')open(vm);setNotice(operation === 'start' ? '环境已启动，正在连接系统。' : operation === 'stop' ? '已发送关机请求，请等待系统正常退出。' : '操作已完成。');}).catch(() => {});};
  const open = (vm: Machine) => {setTabs(old => old.includes(vm.id) ? old : [...old, vm.id]); setActive(vm.id); setPage('machines');};
  const createEnvironment = async (body: unknown, launch = false) => {
    const vm = await action<Machine>('machines', body);
    setCreating(false); setPage('machines');
    if (launch) {
      try {
        const started = await action<Machine>(`machines/${vm.id}/start`);
        open(started); setNotice(started.installation&&started.installation.phase!=='ready'?'首次自动安装已开始，完成后会自动进入系统。安装过程中请保持 DeskLab 运行。':customizing ? '安装好需要的软件并正常关机后，回到测试环境点击“保存为模板”。' : '系统正在启动，稍后会出现桌面或终端。关闭此标签不会关闭系统。');
      } catch (error) {setNotice(`“${vm.name}”已创建，但未能启动。处理下方错误后，可在这个环境上重新点击“启动环境”。`);throw error;}
    } else setNotice('环境已创建。点击“启动环境”进入系统。');
    return vm;
  };
  const ticket = useCallback(async (id: string) => (await action<{ticket: string}>(`machines/${id}/console`)).ticket, [action]);
  const listFiles = useCallback((request:{kind:FilePickerKind;path?:string})=>action<FileListing>('files/list',request),[action]);
  const {pick:pickImage,dialog:filePicker}=useFilePicker(listFiles);
  const selectPage = (value: Page) => {setPage(value); setActive('');};
  const openSettings = (section:'images'|'computer'='images') => {setSettingsSection(section);selectPage('settings');};
  const live = data?.machines.filter(x => ['running','starting','stopping'].includes(x.state)) ?? [];
  const transfers=data?.isoLibrary?.resources.filter(item=>downloading(item.download)) ?? [];
  const current = data?.machines.find(x => x.id === active);
  const connection=data?.machines.find(x=>x.id===connectionId);
  const browsingMachines = page === 'machines' && !current;
  const titles = {machines: '测试环境', templates: '模板库', settings: '本机设置',docker:'Docker 容器',ports:'端口映射'};
  const descriptions={machines:'选一个系统，在浏览器里开始测试。',templates:'模板是准备好的系统。选一个，就能创建自己的环境。',settings:'配置虚拟化引擎，查看本机资源与数据位置。',docker:'连接已有引擎，管理容器、镜像和 Compose 项目。',ports:'查看本机入口、目标端口和所属资源，管理 NAT 服务映射。'};
  const filtered = data?.machines.filter(x => x.name.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || filter === x.family) && (machineState==='all'||x.state===machineState)) ?? [];
  if(exited)return <main className="app-exited"><span className="brand-symbol"><Box size={22}/></span><h1>DeskLab 已退出</h1><p>现在可以关闭这个页面。下次双击桌面上的 DeskLab 图标即可重新打开。</p></main>;
  return <div className={`app-shell unified-workspace${current?' console-open':''}${browsingMachines?' machine-workspace':''}${page==='docker'&&!current?' docker-workspace':''}`}>
    <aside className="sidebar"><a className="brand" href="/" aria-label="DeskLab 首页"><span className="brand-symbol"><Box size={22}/></span><span>DeskLab<small>PERSONAL WORKSPACE</small></span></a>
      <div className="workspace-name"><span className="avatar">S</span><div>本地实验室<small>个人工作空间</small></div><span className="local-tag">LOCAL</span></div>
      <span className="nav-label">工作空间</span><nav aria-label="主导航">{([{id:'machines', icon:Box},{id:'templates', icon:Layers},{id:'docker',icon:Box},{id:'ports',icon:ArrowUpRight},{id:'settings', icon:SlidersHorizontal}] as const).map(item => <button key={item.id} onClick={() => selectPage(item.id)} className={page === item.id ? 'active' : ''}><item.icon size={18}/>{titles[item.id]}{item.id === 'machines' && <span className="nav-count">{data?.machines.length ?? 0}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="host-indicator"><span className={data ? 'online-dot' : 'offline-dot'}/><span>{data ? '本地服务已连接' : '正在连接本地服务'}</span></div><button className="exit-app" disabled={!data||!!busy} onClick={()=>setConfirmExit(true)}><Power size={14}/>退出程序</button><p>DeskLab <span className="mono">v{version}</span></p></div>
    </aside>
    <div className="main-column"><header className="topbar"><div className="breadcrumb">本地实验室 <ChevronRight size={14}/><span>{titles[page]}</span></div><div className="inline">{transfers.length>0&&<button className="download-indicator" onClick={()=>openSettings()}><Download size={14}/>下载中 {transfers.length}</button>}<span className="host-chip"><Monitor size={14}/>Windows 本机</span><button className="icon-button" title="打开本机设置" aria-label="打开本机设置" onClick={() => openSettings('computer')}><SlidersHorizontal size={17}/></button></div></header>
      {tabs.length > 0 && <div className="desktop-tabs"><button className={!active ? 'selected' : ''} onClick={() => setActive('')}><Box size={14}/>工作空间</button>{tabs.map(id => {const vm = data?.machines.find(x => x.id === id); return vm && <div key={id} className={active === id ? 'selected' : ''}><button onClick={() => {setActive(id); setPage('machines');}}><Monitor size={14}/>{vm.name}</button><button aria-label={`关闭 ${vm.name} 桌面标签`} onClick={() => {setTabs(old => old.filter(x => x !== id)); if (active === id) setActive('');}}><X size={13}/></button></div>;})}</div>}
      <main id="main-content" className={browsingMachines?'machine-workspace-main':current?'desktop-workspace-main':page==='docker'?'docker-workspace-main':'standard-workspace-main'}>
        {data && !current && page !== 'settings' && <DiagnosticsSummary state={diagnostics} open={() => openSettings('computer')}/>}
        {error && <div className="alert error" role="alert"><AlertCircle size={18}/><span>{error}</span><button className="icon-button" onClick={clearError} aria-label="关闭错误提示"><X size={16}/></button></div>}
        {notice && <div className="alert success" role="status"><Check size={18}/><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="关闭通知"><X size={16}/></button></div>}
        {!data ? <div className="loading"><LoaderCircle className="spin" size={26}/><p>正在读取本地环境…</p></div> : current ? <Desktop machine={current} ticket={ticket} connect={()=>setConnectionId(current.id)}/> : <>
          {page!=='docker'&&<WorkspaceHeading title={titles[page]} description={descriptions[page]}>{page==='machines'&&<button className="button primary compact" disabled={!!busy} onClick={()=>create()}><Plus size={16}/>创建环境</button>}</WorkspaceHeading>}
          {page === 'machines' && <>
            <div className="resource-strip"><div><Box size={19}/><span>正在运行<strong>{live.length}<small> / {data.machines.length} 个环境</small></strong></span></div><div><Cpu size={19}/><span>已分配 CPU<strong>{live.reduce((n,x) => n+x.cpus,0)}<small> / {data.host.threads} 核</small></strong></span></div><div><MemoryStick size={19}/><span>已分配内存<strong>{(live.reduce((n,x) => n+x.memory,0)/1024).toFixed(1)}<small> / <Bytes value={data.host.totalMemory}/></small></strong></span></div><div className="engine-status"><span className={data.host.qemuFound ? 'online-dot' : 'offline-dot'}/><span>{data.host.qemuFound ? '虚拟化引擎已找到' : '首次使用，准备运行引擎'}<button onClick={() => openSettings('computer')}>{data.host.qemuFound ? '查看本机配置' : '前往本机设置'} <ArrowUpRight size={13}/></button></span></div></div>
            <div className="machine-board"><div className="list-toolbar"><div className="filters"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>全部环境 <span>{data.machines.length}</span></button><button className={filter === 'windows' ? 'selected' : ''} onClick={() => setFilter('windows')}>Windows</button><select aria-label="筛选 Linux 发行版" value={['ubuntu','debian','rocky','linux'].includes(filter) ? filter : ''} onChange={e => setFilter(e.target.value || 'all')}><option value="">Linux 发行版</option>{families.filter(x => x.id !== 'windows').map(x => <option value={x.id} key={x.id}>{x.name}</option>)}</select><select aria-label="筛选环境状态" value={machineState} onChange={e=>setMachineState(e.target.value)}><option value="all">全部状态</option><option value="running">运行中</option><option value="stopped">已关闭</option><option value="error">启动异常</option></select></div><label className="search"><Search size={16}/><input aria-label="搜索环境" placeholder="搜索环境…" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
            <section className="machine-results" aria-label="环境列表" tabIndex={0}>
            {filtered.length ? <MachineList connect={vm=>setConnectionId(vm.id)} machines={filtered} busy={busy} invoke={invoke} open={open} confirm={(vm, operation) => {clearError();setConfirmation({id: vm.id, name: vm.name, operation, kind:'machines'});}}/> : data.machines.length ? <Empty title="没有匹配的环境" description="试试其他名称或系统筛选条件。"/> : <div className="first-environment"><div className="first-copy"><span className="first-symbol"><Terminal size={29}/></span><h2>先选一个系统，其他交给 DeskLab。</h2><p>系统模板已准备好时，无需自己安装。<br/>给环境起个名字，就能打开桌面或终端。</p><button className="button primary" onClick={() => create()}><Plus size={17}/>创建第一个环境</button><span className="quiet-note">运行在本机 · 通过浏览器访问</span></div><div className="first-options"><div className="section-head"><span className="eyebrow">系统自带模板</span></div>{families.slice(0,4).map(os => <button key={os.id} onClick={() => create(os.id)}><span className={`os-mini ${os.id}`}>{os.mark}</span><span><strong>{os.name}</strong><small>{os.id==='windows'?'图形桌面':'Server 终端版'}</small></span><Plus size={17}/></button>)}</div></div>}
            <div className="workflow-note"><Layers size={19}/><div><strong>装好软件，保存成自己的模板。</strong><p>正常关机后点击“保存为模板”，下次从“我的模板”直接创建。</p></div><button onClick={() => {setTemplateGroup('custom');selectPage('templates');}}>查看我的模板 <ArrowUpRight size={15}/></button></div>
            <details className="quick-guide" open={!data.machines.length}><summary>第一次使用？三步就能开始</summary><ol className="template-howto"><li><span>1</span><div><strong>点击“创建环境”</strong><p>从系统自带选择 Windows 或 Linux。</p></div></li><li><span>2</span><div><strong>起名字，创建并启动</strong><p>电脑配置保持默认即可。</p></div></li><li><span>3</span><div><strong>在浏览器里使用</strong><p>用完正常关机；想保留配置就保存为模板。</p></div></li></ol></details>
            </section></div>
          </>}
          {page === 'templates' && <TemplateLibrary key={templateGroup} initialGroup={templateGroup} data={data} create={(id,customize)=>create(undefined,id,customize)} createISO={installIso} manageImages={()=>openSettings()} showMachines={()=>selectPage('machines')} remove={(t: Template) => setConfirmation({id:t.id,name:t.name,kind:'templates',operation:'delete'})} update={(id,body)=>action(`templates/${id}/update`,body)} importing={!!busy} importImage={async body => {const result=await action('templates/import',body);setNotice('模板已导入。点击“创建环境”即可使用。');return result;}} pickImage={pickImage}/>}
          {page === 'settings' && <SettingsPanel diagnostics={diagnostics} action={action} section={settingsSection} setSection={setSettingsSection} data={data} busy={!!busy} save={body => action('settings',body)} scan={()=>action('isos/scan')} pickDirectory={()=>pickImage('directory')} download={id=>action(`isos/${id}/download`)} pause={id=>action(`isos/${id}/pause`)} install={installIso}/>}
          {page === 'docker' && <DockerPanel action={action}/>}
          {page === 'ports' && <PortsPanel machines={data.machines} action={action}/>}
        </>}
      </main><footer className="app-footer"><span>本机存储，无需云端账户</span><span className="mono">DESKLAB / LOCAL FIRST</span></footer>
    </div>
    {confirmExit&&<Modal title="退出 DeskLab" close={()=>{if(!busy)setConfirmExit(false);}}><p>{live.length?'请先正常关闭所有运行中的环境，保存系统里的工作，再退出 DeskLab。':'退出时会暂停下载、停止本程序管理的容器，并正常关闭内置 Docker 引擎。磁盘和数据卷保留；外部 Docker Desktop 继续运行。'}</p>{error&&<p className="form-error" role="alert">{error}</p>}<footer className="modal-foot"><button className="button secondary" disabled={!!busy} onClick={()=>setConfirmExit(false)}>返回</button><button className="button primary" disabled={!!busy||live.length>0} onClick={()=>{void action('app/quit').catch(()=>{});}}>{busy?'正在退出…':'退出程序'}</button></footer></Modal>}
    {creating && data && <CreateMachine data={data} inspectIso={inspectIso} initialFamily={family} initialTemplateId={initialTemplateId} initialIso={initialIso} initialIsoPath={initialIsoPath} customizing={customizing} close={() => setCreating(false)} busy={!!busy} create={createEnvironment} pickImage={pickImage} manageImages={()=>{setCreating(false);openSettings();}}/>}
    {confirmation && <Modal title={confirmation.operation === 'stop' ? '确认关机' : confirmation.operation === 'template' ? '保存为模板' : confirmation.operation === 'reset' ? '恢复初始状态' : confirmation.operation === 'force-stop' ? '强制关闭环境' : '删除确认'} close={() => {if (!busy) setConfirmation(null);}}><form onSubmit={async e => {e.preventDefault(); const f = new FormData(e.currentTarget); try {await action(`${confirmation.kind}/${confirmation.id}/${confirmation.operation}`, confirmation.operation==='template'?templateFields(f):{}); setNotice(confirmation.operation==='stop'?'已发送关机请求，请等待系统正常退出。':confirmation.operation==='template'?'模板已保存。下次点击“创建环境”，从“我的模板”选择它即可使用。':'操作已完成。');if(confirmation.operation==='template'){setTemplateGroup('custom');setActive('');setPage('templates');} setConfirmation(null);} catch {}}}>
      <p className="confirm-copy">{confirmation.operation === 'stop' ? `确定关闭“${confirmation.name}”吗？请先保存系统中的工作。确认后会请求系统正常关机，磁盘和已保存的数据会保留。` : confirmation.operation === 'template' ? `将“${confirmation.name}”里的系统、软件和文件保存下来，下次直接复用。请先在系统内正常关机。保存后会更新这个环境的恢复起点，并自动卸下安装盘。` : confirmation.operation === 'reset' ? `“${confirmation.name}”将恢复到模板状态，模板保存之后的所有改动都会丢失。` : confirmation.operation === 'force-stop' ? `“${confirmation.name}”将立即断电。尚未保存的工作可能丢失，磁盘数据可能损坏。` : `永久删除“${confirmation.name}”及其本地磁盘文件，此操作无法撤销。`}</p>
      {confirmation.operation==='stop'&&data?.machines.some(vm=>vm.id===confirmation.id&&vm.installation&&vm.installation.phase!=='ready')&&<p className="notice">此实例尚未完成安装，关机会中断安装，建议等待安装完成。</p>}
      {confirmation.operation === 'template' && <TemplateFields name={`${confirmation.name} · 我的模板`} value={{memory:data?.machines.find(vm=>vm.id===confirmation.id)?.memory,cpus:data?.machines.find(vm=>vm.id===confirmation.id)?.cpus}}/>}
      {error && <p className="form-error" role="alert">{error}</p>}<footer className="modal-foot"><button type="button" className="button secondary" data-modal-autofocus={confirmation.operation==='stop'?'':undefined} disabled={!!busy} onClick={() => setConfirmation(null)}>取消</button><button className={`button ${confirmation.operation === 'template'||confirmation.operation==='stop' ? 'primary' : 'danger'}`} disabled={!!busy}>{busy && <LoaderCircle size={16} className="spin"/>}{busy ? '正在处理…' : confirmation.operation==='stop'?'确认关机':confirmation.operation==='template'?'保存为模板':'确认操作'}</button></footer>
    </form></Modal>}
    {connection&&<ConnectionInfo key={connection.id} machine={connection} sshKey={data?.sshKey} prepareKey={()=>action<SshKeyInfo>('ssh/key')} busy={!!busy} save={network=>action(`machines/${connection.id}/network`,network)} close={()=>setConnectionId('')}/>}
    {filePicker}
  </div>;
}
