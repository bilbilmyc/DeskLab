import { z } from 'zod';
import { builtinDefinition } from './catalog';
export const family = z.enum(['windows', 'ubuntu', 'debian', 'rocky', 'linux']);
export const firmware = z.enum(['bios', 'uefi']).default('bios');
export const label = z.string().trim().min(1, '请输入名称').max(64).regex(/^[^\x00-\x1f]+$/, '名称不能包含控制字符');
export const memoryInput = z.number().int().min(512).max(65536);
export const cpusInput = z.number().int().min(1).max(32);
export const networkInput=z.object({mode:z.literal('nat').default('nat')}).strict();
const templateDetails = {
  description: z.string().trim().max(500).optional(),
  memory: memoryInput.optional(), cpus: cpusInput.optional(),
  loginHint: z.string().trim().max(500).optional(),
};
export const createInput = z.object({
  name: label, family, memory: memoryInput, cpus: cpusInput,
  diskGB: z.number().int().min(8).max(512), templateId: z.string().uuid().optional(),
  isoPath: z.string().trim().max(2048).optional(), firmware, freshInstall: z.boolean().default(false),
  isoTypeConfirmed:z.boolean().default(false),
  recipeId: z.enum(['ubuntu-server','debian-server','rocky-server','windows-desktop','windows-server']).optional(),
  network:networkInput.optional(),
}).refine(x => Boolean(x.templateId) !== Boolean(x.isoPath), '请选择一个模板或安装 ISO')
  .refine(x => !x.recipeId || (!!x.isoPath && !x.templateId), '自动安装需要选择对应的原版 ISO');
export const settingsInput = z.object({qemuPath: z.string().trim().max(2048).optional(), accelerator: z.enum(['whpx', 'tcg']).optional(), isoDirectory:z.string().trim().max(2048).optional()}).strict()
  .refine(value=>Object.values(value).some(item=>item!==undefined),'请填写要修改的设置');
export const importInput = z.object({name: label, family, firmware, path: z.string().trim().min(1).max(2048), ...templateDetails,
  builtinId: z.string().refine(id => Boolean(builtinDefinition(id)), '系统自带模板不存在').optional()});
export const saveTemplateInput = z.object({name: label, ...templateDetails});
export const updateTemplateInput = z.object({name: label.optional(), ...templateDetails}).strict()
  .refine(value => Object.values(value).some(item => item !== undefined), '请填写要修改的模板设置');
export const idInput = z.string().uuid();
export function qemuValue(path: string) { return path.replaceAll(',', ',,'); }
