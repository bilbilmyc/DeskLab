'use client';
import { useRef, useState } from 'react';
import { Check, CircleHelp, ExternalLink, Cpu, FolderOpen, LoaderCircle, MemoryStick, SlidersHorizontal, ArrowRight, Disc3 } from 'lucide-react';
import type { Family, LabSnapshot } from '@/shared/types';
import { Bytes } from './primitives';
import {DiagnosticsPanel, type DiagnosticState} from './diagnostics';
import { downloading, IsoLibraryPanel } from './iso-library';

export function SettingsPanel({data, save, busy, scan, pickDirectory, download, pause, install, section, setSection, diagnostics, action}: {diagnostics: DiagnosticState; action: <T = unknown>(path: string, body?: unknown) => Promise<T>; data: LabSnapshot; save: (value: unknown) => Promise<unknown>; busy: boolean; scan:()=>Promise<unknown>;pickDirectory:()=>Promise<{path:string|null}>;download:(id:string)=>Promise<unknown>;pause:(id:string)=>Promise<unknown>;install:(path:string,family:Family)=>void;section:'images'|'computer';setSection:(section:'images'|'computer')=>void}) {
  const [saved, setSaved] = useState(false);
  const imagesButton = useRef<HTMLButtonElement>(null);
  const transfers = data.isoLibrary?.resources.filter(item=>downloading(item.download)).length ?? 0;
  return <div className="settings-workspace">
    <div className="settings-navigation"><div className="segmented" aria-label="设置分类">
      <button ref={imagesButton} className={section==='images'?'selected':''} aria-pressed={section==='images'} aria-controls="settings-images" onClick={()=>setSection('images')}><Disc3 size={16}/>系统镜像{transfers>0&&<span>下载中 {transfers}</span>}</button>
      <button className={section==='computer'?'selected':''} aria-pressed={section==='computer'} aria-controls="settings-computer" onClick={()=>setSection('computer')}><SlidersHorizontal size={16}/>运行与存储</button>
    </div><p>{section==='images'?'找到安装盘，或下载一个新系统。':'查看电脑资源、运行引擎和文件位置。'}</p></div>
    <div id="settings-images" className="workspace-scroll settings-results" role="region" aria-label="系统镜像设置" tabIndex={0} hidden={section!=='images'}><IsoLibraryPanel data={data} save={save} busy={busy} scan={scan} pickDirectory={pickDirectory} download={download} pause={pause} install={install}/></div>
    <div id="settings-computer" className="workspace-scroll settings-results" role="region" aria-label="运行与存储设置" tabIndex={0} hidden={section!=='computer'}><DiagnosticsPanel state={diagnostics} action={action}/><div className="settings-card-grid">
      <section className="panel engine-card"><div className="settings-card-heading"><span className="settings-symbol"><Cpu size={20}/></span><div><h2>运行环境</h2><p>使用本机资源运行测试系统。</p></div></div>
        <div className="computer-facts"><div><Cpu size={16}/><span>处理器<strong>{data.host.threads} 核</strong></span></div><div><MemoryStick size={16}/><span>内存<strong><Bytes value={data.host.totalMemory}/></strong></span></div></div>
        <p className="computer-description">{data.host.cpu}<br/>{data.host.platform} / {data.host.arch} · 当前可用内存 <Bytes value={data.host.freeMemory}/></p>
        <details className="workspace-guide engine-advanced"><summary>修改引擎配置</summary><form className="engine-settings-form" onChange={()=>setSaved(false)} onSubmit={async e=>{e.preventDefault();setSaved(false);const f=new FormData(e.currentTarget);try{await save({qemuPath:f.get('qemuPath'),accelerator:f.get('accelerator')});setSaved(true);}catch{}}}>
          <label>QEMU 程序目录<input name="qemuPath" defaultValue={data.settings.qemuPath} placeholder="留空使用内置引擎" spellCheck={false}/></label><p className="field-help">正式 EXE 已包含引擎，需要时再指定其他目录。</p>
          <label>虚拟化方式<select name="accelerator" defaultValue={data.settings.accelerator}><option value="whpx">Windows 硬件加速（WHPX）</option><option value="tcg">软件模拟（TCG，仅诊断使用）</option></select></label>
          <p className="field-help">硬件加速需启用“Windows 虚拟机监控程序平台”。软件模拟速度较慢。</p>
          <div className="engine-save"><button className="button primary" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>}保存并检测</button>{saved&&<span className="saved" role="status">设置已保存</span>}</div>
        </form></details>
        <div className="checks"><div>{data.host.qemuFound?<Check size={17}/>:<CircleHelp size={17}/>}<span>QEMU 引擎</span><strong>{data.host.qemuFound?'已找到':'待配置'}</strong></div><div>{data.host.imageToolFound?<Check size={17}/>:<CircleHelp size={17}/>}<span>虚拟磁盘工具</span><strong>{data.host.imageToolFound?'已找到':'待配置'}</strong></div><div><CircleHelp size={17}/><span>硬件加速</span><strong>启动时验证</strong></div></div>
        {data.host.qemuVersion&&<details className="engine-version"><summary>查看引擎版本</summary><p className="mono">{data.host.qemuVersion}</p></details>}
      </section>
      <section className="panel data-card"><div className="settings-card-heading"><span className="settings-symbol"><FolderOpen size={20}/></span><div><h2>本地存储</h2><p>环境和镜像都保存在你的电脑上。</p></div></div>
        <dl className="storage-paths"><dt>环境、模板与配置</dt><dd><code>{data.host.dataDirectory}</code></dd><dt>ISO 安装盘</dt><dd><code>{data.host.isoDirectory}</code></dd></dl>
        <p className="field-help">元数据保存在 <code>{data.host.databasePath??'desklab.sqlite'}</code>；虚拟磁盘仍是独立文件。升级程序不会覆盖数据。备份前请关闭全部环境和 DeskLab，再备份完整数据目录。</p>
        <button className="text-button" onClick={()=>{setSection('images');imagesButton.current?.focus();}}>管理 ISO 目录 <ArrowRight size={14}/></button>
      </section>
      <section className="panel help-card"><div className="settings-card-heading"><span className="settings-symbol"><CircleHelp size={20}/></span><div><h2>首次使用帮助</h2><p>有需要时，展开查看。</p></div></div>
        <details><summary>如何准备运行引擎？</summary><p>正式 EXE 已包含 QEMU，首次启动会自动准备。源码运行可配置外部引擎。</p><a href="https://www.qemu.org/download/#windows" target="_blank" rel="noreferrer">官方 Windows 下载入口 <ExternalLink size={13}/></a></details>
        <details><summary>如何开启硬件加速？</summary><p>在 Windows 的“启用或关闭 Windows 功能”中勾选“Windows 虚拟机监控程序平台”，再按提示重启电脑。</p></details>
        <details><summary>模板和 ISO 应该怎么选？</summary><p>已准备好的模板可以直接创建环境。ISO 是安装盘，需要先完成安装，之后也可以保存为自己的模板。</p></details>
      </section>
    </div></div>
  </div>;
}
