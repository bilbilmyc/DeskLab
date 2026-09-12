import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuiltinTemplate, Template } from '../shared/types';
import { preparedImages } from './bundle';

type Definition = Omit<BuiltinTemplate, 'templateId'> & {legacyTemplateId: string};
const linuxLogin = '已配置自动登录；账号 root，密码 DeskLab0987。';
const windowsLogin = '已配置自动登录；账号 Administrator，密码 DeskLab0987。';

// Small descriptions and defaults are compiled into the application. OS disks
// remain separate resources and are only offered as ready when their file exists.
export const builtinTemplates: readonly Definition[] = [
  {id:'ubuntu-server', name:'Ubuntu 24.04.5 Server', family:'ubuntu', description:'终端系统，适合学习 Linux、运行开发工具和测试服务。', interface:'terminal', memory:2048, cpus:2, diskGB:40, firmware:'bios', loginHint:linuxLogin, legacyTemplateId:'bdf44d4a-8d11-49a7-97f3-891739eeadc6'},
  {id:'debian-server', name:'Debian 13.6 Server', family:'debian', description:'简洁的终端系统，适合命令行工具和软件兼容测试。', interface:'terminal', memory:2048, cpus:2, diskGB:40, firmware:'bios', loginHint:linuxLogin, legacyTemplateId:'3628f107-3bed-4f1c-8fd8-e5c9ed182e08'},
  {id:'rocky-server', name:'Rocky Linux 9.8 Server', family:'rocky', description:'终端系统，适合企业 Linux 软件和服务测试。', interface:'terminal', memory:2048, cpus:2, diskGB:40, firmware:'bios', loginHint:linuxLogin, legacyTemplateId:'f0068223-18c2-4201-9750-3ee4a1b46737'},
  {id:'windows-desktop', name:'Windows 10 Enterprise 22H2', family:'windows', description:'英文图形桌面，适合 Windows 软件测试。此模板使用限时评估版。', interface:'desktop', memory:4096, cpus:2, diskGB:64, firmware:'uefi', loginHint:windowsLogin, legacyTemplateId:'ce1c86d8-0a40-4023-8e60-726b1c8ad5cd'},
  {id:'windows-server', name:'Windows Server 2022', family:'windows', description:'中文图形桌面，适合 Windows 服务测试。此模板使用限时评估版。', interface:'desktop', memory:4096, cpus:2, diskGB:64, firmware:'uefi', loginHint:windowsLogin, legacyTemplateId:'d68377ef-0338-4dca-83a3-8acc7f0ef9d3'},
  {id:'ubuntu-desktop', name:'Ubuntu 24.04.5 Desktop', family:'ubuntu', description:'带图形桌面的 Linux，适合桌面应用和可视化工具测试。', interface:'desktop', memory:8192, cpus:2, diskGB:40, firmware:'bios', loginHint:linuxLogin, legacyTemplateId:'c477ad26-ca4b-48b7-8771-0e55a6185df2'},
  {id:'debian-desktop', name:'Debian 13.6 GNOME', family:'debian', description:'GNOME 图形桌面，适合 Linux 桌面应用测试。', interface:'desktop', memory:4096, cpus:2, diskGB:40, firmware:'bios', loginHint:linuxLogin, legacyTemplateId:'b43659d2-e7c2-4eea-8260-23831619ebc3'},
  {id:'rocky-desktop', name:'Rocky Linux 9.8 Workstation', family:'rocky', description:'带图形桌面的 Rocky Linux，适合工作站软件测试。', interface:'desktop', memory:4096, cpus:2, diskGB:40, firmware:'bios', loginHint:linuxLogin, legacyTemplateId:'698a7844-72e9-433d-8b7e-9bd9d9261919'},
];

export function builtinDefinition(id: string) { return builtinTemplates.find(item => item.id === id); }

/** Tag known installed resources once. The installer ISO is not a dependency. */
export async function migrateBuiltinTemplates(templates: Template[], isoDirectory?: string) {
  const manifest = await preparedImages(isoDirectory);
  let changed = false;
  for (const builtin of builtinTemplates) {
    const pairedIds = new Set(manifest.filter(item => item.id === builtin.id).map(item => item.templateId));
    pairedIds.add(builtin.legacyTemplateId);
    for (const template of templates) {
      if (template.builtinId || template.family !== builtin.family || !pairedIds.has(template.id)) continue;
      template.builtinId = builtin.id;
      template.description ??= builtin.description;
      template.memory ??= builtin.memory;
      template.cpus ??= builtin.cpus;
      template.firmware ??= builtin.firmware;
      template.loginHint ??= builtin.loginHint;
      changed = true;
    }
  }
  return changed;
}

export async function templateDiskExists(dataDirectory: string, template: Template) {
  // Metadata loaded from a previous version must never resolve outside its library.
  if (!/^[a-f0-9-]{36}$/i.test(template.id)) return false;
  return stat(join(dataDirectory, 'templates', template.id, 'base.qcow2')).then(file => file.isFile()).catch(() => false);
}

export async function templateCatalogue(templates: Template[], dataDirectory: string): Promise<BuiltinTemplate[]> {
  return Promise.all(builtinTemplates.map(async ({legacyTemplateId: _legacy, ...builtin}) => {
    const candidates = templates.filter(template => template.builtinId === builtin.id);
    const available = await Promise.all(candidates.map(template => templateDiskExists(dataDirectory, template)));
    const template = candidates.find((_template, index) => available[index]);
    const entry = {...builtin, autoInstall: ['ubuntu-server','debian-server','rocky-server','windows-desktop','windows-server'].includes(builtin.id)};
    return template ? {...entry, templateId:template.id, diskGB:template.diskGB, memory:template.memory ?? builtin.memory,
      cpus:template.cpus ?? builtin.cpus, loginHint:template.loginHint ?? '请使用该镜像原有的账号登录。'} : entry;
  }));
}
