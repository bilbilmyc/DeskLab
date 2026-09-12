'use client';
import type { Template } from '@/shared/types';
export function TemplateFields({value, name = ''}: {value?: Partial<Template>; name?: string}) {
  return <>
    <label>模板名称<input name="name" required maxLength={64} defaultValue={value?.name ?? name} placeholder="例如：我的 Bun 开发环境"/></label>
    <label>说明 <span className="optional">选填</span><textarea name="description" maxLength={500} rows={2} defaultValue={value?.description ?? ''} placeholder="例如：已安装 Bun、Git，可直接运行项目。"/></label>
    <details className="advanced-options"><summary>默认资源与登录说明 <span>选填</span></summary>
      <div className="form-grid two-columns">
        <label>默认处理器<input type="number" name="cpus" required min={1} max={32} defaultValue={value?.cpus ?? 2}/><span className="field-help">核；创建环境时仍可调整</span></label>
        <label>默认内存<select name="memory" defaultValue={value?.memory ?? 2048}>{[...new Set([512,1024,2048,4096,8192,16384,32768,65536,value?.memory ?? 2048])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n/1024} GB</option>)}</select></label>
      </div>
      <label>登录说明<textarea name="loginHint" maxLength={500} rows={2} defaultValue={value?.loginHint ?? ''} placeholder="例如：进入终端后使用我设置的账号登录。"/></label>
      <p className="field-help">这段文字只用来提醒你，不会修改系统内的账号或密码。</p>
    </details>
  </>;
}
export function templateFields(form: FormData) {
  return {name: form.get('name'), description: form.get('description'), loginHint: form.get('loginHint'), memory:Number(form.get('memory')),cpus:Number(form.get('cpus'))};
}
