import type {Family} from './types';
export interface IsoInspection {
  status:'match'|'mismatch'|'unknown';
  message:string;
  label?:string;
  detectedFamily?:Family;
  suggestedRecipeId?:string;
  requiresConfirmation:boolean;
}
