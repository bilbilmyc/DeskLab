export type FilePickerKind = 'iso' | 'disk' | 'directory' | 'compose';

export interface FileListing {
  path: string;
  parent: string | null;
  entries: {name: string; path: string; directory: boolean}[];
  shortcuts: {name: string; path: string}[];
  truncated: boolean;
}
