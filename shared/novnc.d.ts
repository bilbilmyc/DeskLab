declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: HTMLElement, url: string);
    scaleViewport: boolean; resizeSession: boolean;
    disconnect(): void; sendCtrlAltDel(): void; focus(): void;
    addEventListener(event: string, callback: (event: CustomEvent) => void): void;
  }
}
