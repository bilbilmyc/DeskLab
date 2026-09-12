import type { Family, Firmware } from '../shared/types';

export interface IsoSource {
  id: string; name: string; family: Family; firmware: Firmware; file: string;
  bytes: number; sha256: string | null; url?: string; unavailableReason?: string;
  sourcePage: string; checksumSource?: string;
}

// Pinned installer media; compiled into the executable independently of iso/.
// These are installation ISOs, not the preinstalled template disks. Source and
// integrity verification notes are kept in docs/iso-sources.md.
export const isoSources: readonly IsoSource[] = [
  {
    id:'ubuntu-server', name:'Ubuntu 24.04.5 Server', family:'ubuntu', firmware:'bios',
    file:'ubuntu-24.04.5-live-server-amd64.iso', bytes:4080486400,
    url:'https://ftp.sjtu.edu.cn/ubuntu-cd/24.04.5/ubuntu-24.04.5-live-server-amd64.iso',
    sha256:'97f3d7ffb032c3eb3b23d2c8be9cc76e60c2c1f2c0146ba5ba9fe01cafae0fd8',
    sourcePage:'https://releases.ubuntu.com/24.04.5/',
    checksumSource:'https://releases.ubuntu.com/24.04.5/SHA256SUMS',
  },
  {
    id:'debian-server', name:'Debian 13.6 Server', family:'debian', firmware:'bios',
    file:'debian-13.6.0-amd64-DVD-1.iso', bytes:3992977408,
    url:'https://cdimage.debian.org/debian-cd/13.6.0/amd64/iso-dvd/debian-13.6.0-amd64-DVD-1.iso',
    sha256:'e97736b7f49af22497c8df95e381ea5025faf3575af4b7ca6d5f40971265364e',
    sourcePage:'https://cdimage.debian.org/debian-cd/13.6.0/amd64/iso-dvd/',
    checksumSource:'https://cdimage.debian.org/debian-cd/13.6.0/amd64/iso-dvd/SHA256SUMS',
  },
  {
    id:'rocky-server', name:'Rocky Linux 9.8 Server', family:'rocky', firmware:'bios',
    file:'Rocky-9.8-x86_64-minimal.iso', bytes:2755067904,
    url:'https://download.rockylinux.org/pub/rocky/9.8/isos/x86_64/Rocky-9.8-x86_64-minimal.iso',
    sha256:'d338032cd1cdd41c67139f2f71b4c832c8e4a21943106519db9c7137df7a63d4',
    sourcePage:'https://download.rockylinux.org/pub/rocky/9.8/isos/x86_64/',
    checksumSource:'https://download.rockylinux.org/pub/rocky/9.8/isos/x86_64/CHECKSUM',
  },
  {
    id:'windows-desktop', name:'Windows 10 Enterprise 22H2', family:'windows', firmware:'uefi',
    file:'Windows_10_Enterprise_22H2_Evaluation_en-us_x64.iso', bytes:5550497792,
    url:'https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66750/19045.2006.220908-0225.22h2_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso',
    sha256:'ef7312733a9f5d7d51cfa04ac497671995674ca5e1058d5164d6028f0938d668',
    sourcePage:'https://download.microsoft.com/download/c/1/1/c11d2ca5-967c-45c0-bc7d-2d9ca3f1fe07/Windows10Enterprise22H2HashValues.pdf',
    checksumSource:'https://download.microsoft.com/download/c/1/1/c11d2ca5-967c-45c0-bc7d-2d9ca3f1fe07/Windows10Enterprise22H2HashValues.pdf',
  },
  {
    id:'windows-server', name:'Windows Server 2022', family:'windows', firmware:'uefi',
    file:'Windows_Server_2022_Evaluation_zh-cn_x64.iso', bytes:5478957056,
    url:'https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66756/20348.1787.230607-0640.fe_release_svc_refresh_SERVER_EVAL_x64FRE_zh-cn.iso',
    // No published Microsoft SHA256 was found. Do not substitute a local hash
    // and present it as a publisher-authenticated integrity check.
    sha256:null,
    sourcePage:'https://www.microsoft.com/en-us/evalcenter/download-windows-server-2022',
  },
  {
    id:'ubuntu-desktop', name:'Ubuntu 24.04.5 Desktop', family:'ubuntu', firmware:'bios',
    file:'ubuntu-24.04.5-desktop-amd64.iso', bytes:6312734720,
    url:'https://nl3.releases.ubuntu.com/releases/24.04.5/ubuntu-24.04.5-desktop-amd64.iso',
    sha256:'63bed7c60c252d5563742b19204ff228ef9f7f10ac0a060159897ab423b6c398',
    sourcePage:'https://nl3.releases.ubuntu.com/releases/24.04.5/',
    checksumSource:'https://nl3.releases.ubuntu.com/releases/24.04.5/SHA256SUMS',
  },
  {
    id:'debian-desktop', name:'Debian 13.6 GNOME', family:'debian', firmware:'bios',
    file:'debian-live-13.6.0-amd64-gnome.iso', bytes:3800989696,
    url:'https://cdimage.debian.org/debian-cd/13.6.0-live/amd64/iso-hybrid/debian-live-13.6.0-amd64-gnome.iso',
    sha256:'1aa47465568cfc259b93ea7687a510d7f109df766daabbc69139ed99a25a71c9',
    sourcePage:'https://cdimage.debian.org/debian-cd/13.6.0-live/amd64/iso-hybrid/',
    checksumSource:'https://cdimage.debian.org/debian-cd/13.6.0-live/amd64/iso-hybrid/SHA256SUMS',
  },
  {
    id:'rocky-desktop', name:'Rocky Linux 9.8 Workstation', family:'rocky', firmware:'bios',
    file:'Rocky-9.8-Workstation-x86_64-20260525.0.iso', bytes:2653243392,
    url:'https://download.rockylinux.org/pub/rocky/9.8/live/x86_64/Rocky-9.8-Workstation-x86_64-20260525.0.iso',
    sha256:'1a6d3d5fcfa855d0ded006ea24e112fd5ea3656b74da886ea97724df5772fe87',
    sourcePage:'https://download.rockylinux.org/pub/rocky/9.8/live/x86_64/',
    checksumSource:'https://download.rockylinux.org/pub/rocky/9.8/live/x86_64/Rocky-9.8-Workstation-x86_64-20260525.0.iso.CHECKSUM',
  },
];
