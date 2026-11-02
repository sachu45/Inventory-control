import { forwardRef, type SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number; absoluteStrokeWidth?: boolean };
export type LucideIcon = ReturnType<typeof makeIcon>;
const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10 M7 5l10 4',
  chart: 'M4 3v17h17 M8 15v-4 M13 15V7 M18 15v-7',
  file: 'M14 3H5v18h14V8z M14 3v5h5 M8 12h8 M8 16h6',
  people: 'M15 21v-3a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v3 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a3 3 0 0 1 0 6 M18 14a4 4 0 0 1 3 4v3',
  building: 'M4 21V5h11v16 M15 11h5v10 M2 21h20 M8 9h3 M8 13h3 M8 17h3',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
  check: 'M5 12l4 4L19 6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l4 2',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
  bell: 'M5 17h14l-2-3V9A5 5 0 0 0 7 9v5z M10 21h4 M12 2v2',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  warning: 'M12 3L2 21h20z M12 9v5 M12 17v1',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2 M12 16.5v.1',
  mail: 'M3 5h18v14H3z M3 5l9 8 9-8',
  plus: 'M12 5v14 M5 12h14',
  idea: 'M8 16c0-2-3-3-3-7a7 7 0 0 1 14 0c0 4-3 5-3 7z M8 19h8 M10 22h4',
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M9 5l7 7-7 7',
  money: 'M12 2v20 M17 6H9a4 4 0 0 0 0 8h6a4 4 0 0 1 0 8H6',
  cart: 'M2 3h3l3 13h11l3-9H6 M9 20h1 M18 20h1',
  calendar: 'M3 5h18v16H3z M7 2v6 M17 2v6 M3 10h18 M7 14h3 M14 14h3',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  refresh: 'M20 10a8 8 0 1 0-1 8 M20 3v7h-7',
  trash: 'M3 6h18 M8 6V3h8v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  edit: 'M4 16L16 4l4 4L8 20H4z M13 7l4 4',
  lock: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
};
function makeIcon(name: string, glyph = 'file', rotation = 0) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(({ size = 20, strokeWidth = 1.7, absoluteStrokeWidth: _absolute, ...props }, ref) => (
    <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={paths[glyph]} transform={rotation ? `rotate(${rotation} 12 12)` : undefined} />
    </svg>
  ));
  Icon.displayName = name;
  return Icon;
}
export const LayoutDashboard=makeIcon('Dashboard','grid'), Shapes=makeIcon('Shapes','grid'), Square=makeIcon('Square','grid'), QrCode=makeIcon('QrCode','grid');
export const Lightbulb=makeIcon('Idea','idea');
export const Package=makeIcon('Package','box'), Boxes=makeIcon('Boxes','box'), PackageOpen=makeIcon('Open package','box'), PackageCheck=makeIcon('Checked package','box'), PackagePlus=makeIcon('Add package','box'), PackageSearch=makeIcon('Find package','box'), Warehouse=makeIcon('Warehouse','building');
export const BarChart3=makeIcon('Analytics','chart'), Activity=makeIcon('Activity','chart'), TrendingUp=makeIcon('Trend up','chart'), TrendingDown=makeIcon('Trend down','chart');
export const Users=makeIcon('Users','people'), User=makeIcon('User','people'), UserCircle=makeIcon('UserCircle','people'), UserCog=makeIcon('UserCog','people'), Handshake=makeIcon('Partners','people');
export const Building2=makeIcon('Company','building'), Factory=makeIcon('Plant','building'), Store=makeIcon('Store','building'), Monitor=makeIcon('Monitor','grid');
export const ArrowRight=makeIcon('Right','arrow'), ArrowLeft=makeIcon('Left','arrow',180), ArrowUpRight=makeIcon('Open','arrow',-45), ArrowUpFromLine=makeIcon('Outbound','arrow',-90), ArrowDownToLine=makeIcon('Inbound','download'), ArrowDown=makeIcon('Down','arrow',90), ArrowRightFromLine=makeIcon('Exit','arrow'), ArrowLeftRight=makeIcon('Transfer','arrow'), ArrowRightLeft=makeIcon('Movement','arrow'), ExternalLink=makeIcon('External','arrow',-45), LogOut=makeIcon('Sign out','arrow');
export const Check=makeIcon('Check','check'), CheckCircle2=makeIcon('Complete','check'), CheckSquare=makeIcon('Checked','check'), BadgeCheck=makeIcon('Verified','check'), ShieldCheck=makeIcon('Secure','check');
export const Clock=makeIcon('Clock','clock'), Clock3=makeIcon('Time','clock'), CalendarClock=makeIcon('Calendar','calendar'), Calendar=makeIcon('Calendar','calendar');
export const Search=makeIcon('Search','search'), Compass=makeIcon('Navigate','search'), Bell=makeIcon('Notifications','bell'), Settings=makeIcon('Settings','settings'), SlidersHorizontal=makeIcon('Filters','settings'), ListFilter=makeIcon('Filter','menu');
export const AlertTriangle=makeIcon('Warning','warning'), AlertCircle=makeIcon('Alert','warning'), ShieldAlert=makeIcon('Security alert','warning'), HelpCircle=makeIcon('Help','help');
export const Mail=makeIcon('Mail','mail'), MessageCircle=makeIcon('Message','mail'), MessageSquare=makeIcon('Comment','mail'), Send=makeIcon('Send','arrow',-45);
export const Plus=makeIcon('Add','plus'), Minus=makeIcon('Remove','menu'), X=makeIcon('Close','close'), XCircle=makeIcon('Cancel','close'), Ban=makeIcon('Blocked','close');
export const ChevronRight=makeIcon('Expand','chevron'), ChevronLeft=makeIcon('Back','chevron',180), ChevronDown=makeIcon('Down','chevron',90), ChevronUp=makeIcon('Up','chevron',-90), ChevronsLeft=makeIcon('Collapse','chevron',180), ChevronsRight=makeIcon('Expand','chevron');
export const DollarSign=makeIcon('Value','money'), IndianRupee=makeIcon('Amount','money'), Banknote=makeIcon('Payment','money'), HandCoins=makeIcon('Supplier payment','money'), Wallet=makeIcon('Wallet','money'), CreditCard=makeIcon('Billing','money');
export const Menu=makeIcon('Menu','menu'), RefreshCw=makeIcon('Refresh','refresh'), Repeat2=makeIcon('Repeat','refresh'), Loader2=makeIcon('Loading','refresh'), Trash2=makeIcon('Delete','trash'), Download=makeIcon('Download','download'), Upload=makeIcon('Upload','download',180), HardDriveDownload=makeIcon('Backup','download'), Cloud=makeIcon('Cloud','download');
export const Edit=makeIcon('Edit','edit'), Pencil=makeIcon('Pencil','edit'), Paintbrush=makeIcon('Appearance','edit'), Lock=makeIcon('Lock','lock'), LockKeyhole=makeIcon('Lock','lock'), KeyRound=makeIcon('Key','lock'), Shield=makeIcon('Shield','lock'), Eye=makeIcon('Show','eye'), EyeOff=makeIcon('Hide','eye');
export const FileText=makeIcon('Document'), FileCheck=makeIcon('Approved document'), FileCheck2=makeIcon('Verified document'), FileDown=makeIcon('Export'), FileSpreadsheet=makeIcon('Spreadsheet'), FileSignature=makeIcon('Contract'), FileSearch=makeIcon('Find document'), ScrollText=makeIcon('Quote'), ClipboardList=makeIcon('Orders'), ClipboardCheck=makeIcon('Approved order'), Receipt=makeIcon('Receipt'), ReceiptText=makeIcon('Invoice'), Copy=makeIcon('Copy'), Save=makeIcon('Save'), Printer=makeIcon('Print');
export const ShoppingCart=makeIcon('Sales','cart'), Truck=makeIcon('Delivery','cart'), Route=makeIcon('Route','arrow'), GitBranch=makeIcon('Workflow','arrow'), Link2=makeIcon('Link','arrow'), CornerDownLeft=makeIcon('Return','arrow',180);
export const Barcode=makeIcon('Barcode','grid'), ScanBarcode=makeIcon('Scan barcode','grid'), ScanLine=makeIcon('Scan','grid'), ImageIcon=makeIcon('Image','grid'), ImagePlus=makeIcon('Add image','grid'), Maximize2=makeIcon('Fullscreen','grid'), Minimize2=makeIcon('Exit fullscreen','grid'), DatabaseBackup=makeIcon('Database','building');
export const Star=makeIcon('Star','check'), Award=makeIcon('Award','check'), Trophy=makeIcon('Achievement','check'), Crown=makeIcon('Plan','check'), Sparkles=makeIcon('Assistant','menu'), Zap=makeIcon('Action','chart'), Bot=makeIcon('Assistant','grid'), Brain=makeIcon('Intelligence','chart');
export const Circle=makeIcon('Circle','clock'), Cookie=makeIcon('Cookies','settings'), Command=makeIcon('Command','grid'), Keyboard=makeIcon('Keyboard','grid'), Moon=makeIcon('Dark mode','clock'), Sun=makeIcon('Light mode','clock'), Smartphone=makeIcon('Mobile','file'), Phone=makeIcon('Phone','file'), MapPin=makeIcon('Location','building'), MoreHorizontal=makeIcon('More','menu'), Paperclip=makeIcon('Attachment','file'), Pin=makeIcon('Pin','lock'), PinOff=makeIcon('Unpin','lock'), Play=makeIcon('Play','chevron'), PlayCircle=makeIcon('Run','chevron'), ToggleLeft=makeIcon('Toggle','settings');
