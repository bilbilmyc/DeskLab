import { windowsIconPath } from './generate-icon';

export function windowsBranding(version: string): NonNullable<Bun.CompileBuildOptions['windows']> {
  // PE file versions are numeric; the UI/API and installer retain the full RC name.
  const numericVersion=version.split('-')[0].split('+')[0];
  return {
    icon: windowsIconPath,
    hideConsole: true,
    title: 'DeskLab',
    publisher: 'DeskLab',
    version:numericVersion,
    description: 'DeskLab — Local Windows and Linux test environments',
    copyright: 'Copyright (c) 2026 DeskLab',
  };
}
