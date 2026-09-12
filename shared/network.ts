// Legacy bridge fields remain readable so old disks/settings are not discarded.
// New requests accept NAT only (server/validation.ts).
export interface MachineNetwork {mode:'nat'|'bridged';adapterId?:string;address?:string;}
export interface BridgeAdapter {id:string;name:string;description:string;bridged:boolean;}
export interface NetworkCapabilities {adapters:BridgeAdapter[];message?:string;}
export interface PhysicalAdapter {id:string;name:string;description:string;status:string;wireless:boolean;}
export type NetworkSetupState='idle'|'awaiting-admin'|'preparing'|'configuring'|'rolling-back'|'rolled-back'|'validated'|'ready'|'failed'|'needs-recovery';
export interface NetworkSetupOperation {operationId:string;state:NetworkSetupState;message:string;updatedAt?:string;}
export interface NetworkSetupStatus {physicalAdapters:PhysicalAdapter[];operation?:NetworkSetupOperation;recoveryOperations?:NetworkSetupOperation[];canPrepare:boolean;message:string;}
