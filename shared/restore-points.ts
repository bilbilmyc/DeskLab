import type {Firmware} from './types';

export interface RestorePoint {
  id: string; name: string; createdAt: string; bytes: number; diskGB: number;
  firmware: Firmware; diskSha256: string; uefiSha256?: string;
  sshPublicKey?: string; sshKeyFingerprint?: string;
}
export interface RestorePointOperation {
  machineId: string; kind: 'create' | 'restore' | 'delete'; startedAt: string;
  stage: 'preparing' | 'copying' | 'verifying' | 'committing' | 'cleaning';
}
