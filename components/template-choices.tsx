'use client';
import { Check, Monitor, Terminal } from 'lucide-react';
import type { BuiltinTemplate, Template } from '@/shared/types';
import { OsIcon } from './primitives';
export function TemplateChoices({items, selected, select}: {items:(BuiltinTemplate | Template)[];selected:string;select:(id:string)=>void}) {
  const rows=(list:typeof items)=>list.map(t=>{
    const builtin='interface' in t, ready=!builtin || !!t.templateId;
    return <button type="button" key={t.id} className={`template-choice ${selected===t.id?'selected':''}`} aria-pressed={selected===t.id} onClick={()=>select(t.id)}>
      <OsIcon family={t.family} small/><span className="choice-copy"><strong>{t.name}</strong><span>{builtin ? <>{t.interface==='terminal'?<Terminal size={12}/>:<Monitor size={12}/>} {t.interface==='terminal'?'终端版':'桌面版'} · </>:null}{ready?'已准备好':builtin&&t.autoInstall?'首次自动安装':'需要准备系统'}</span></span>{selected===t.id && <Check size={17}/>}
    </button>;
  });
  const extra=items.filter(t=>'interface' in t && t.interface==='desktop' && t.family!=='windows');
  const main=items.filter(t=>!extra.includes(t));
  return <><div className="template-choices" aria-label="选择系统模板">{rows(main)}</div>{extra.length>0 && <details className="extra-templates" open={extra.some(t=>t.id===selected)}><summary>其他 Linux 桌面模板 <span>{extra.length}</span></summary><div className="template-choices">{rows(extra)}</div></details>}</>;
}
