export type ManagedState='preparing'|'starting'|'running'|'stopping'|'stopped'|'error';
export interface ManagedEngineRecord {
 id:string;imageId:string;imagePath:string;memoryMB:number;cpus:number;diskGB:number;dataId:string;
 state:ManagedState;message?:string;initialized:boolean;managementPort?:number;qmpPort?:number;agentPort?:number;pid?:number;
 credentialsGeneration?:string;certificateFingerprint?:string;certificateExpiresAt?:string;
 restoreGeneration?:string;
 createdAt:string;updatedAt:string;
}
export interface ManagedEngineView extends ManagedEngineRecord {directory:string;diskBytes?:number;diskFreeBytes?:number;imageAvailable:boolean;}
export interface EngineBackup {id:string;engineId:string;createdAt:string;bytes:number;label:string;}
export interface ManagedAvailability {available:boolean;imageId?:string;error?:string;engine?:ManagedEngineView;backups:EngineBackup[];}
