import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BrandLogoMark } from '@/components/BrandLogo';
import { ArrowLeft, ShieldCheck } from '@/components/ui/icons';

/** Shared presentation only: forms keep their existing authentication handlers. */
export function AuthLayout({ children, headline = 'Your business.\nConnected.', description = 'Inventory, purchasing and sales. One clear workspace to keep your operations moving.', wide = false }: {
  children: ReactNode; headline?: string; description?: string; wide?: boolean;
}) {
  return <div className={`erp-auth ${wide ? 'erp-auth-wide' : ''}`}>
    <section className="erp-auth-brand" aria-label="About SoftdigitIMS">
      <Link to="/" className="erp-auth-logo" aria-label="SoftdigitIMS home"><BrandLogoMark size={34} /><span>SoftdigitIMS</span><small>BUSINESS WORKSPACE</small></Link>
      <div className="erp-auth-story">
        <span className="auth-eyebrow">A CLEARER WAY TO WORK</span>
        <h1>{headline}</h1><p>{description}</p>
        <div className="auth-workflow-illustration">
          <div className="auth-illustration-heading"><span className="auth-window-mark" /><span>Your connected operations</span><span className="auth-live-label">WORKFLOW</span></div>
          <svg viewBox="0 0 480 240" role="img" aria-label="Purchasing connects to inventory, sales and reporting in one workspace">
            <defs><pattern id="workflow-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#dbe4ed" /></pattern></defs>
            <rect width="480" height="240" fill="url(#workflow-dots)" />
            <g fill="none" stroke="#b0c1d3" strokeWidth="1.5"><path d="M144 70h70v100h122 M144 170h70 M288 70h48" /></g>
            <g fill="#fff" stroke="#dbe4ed"><rect x="24" y="40" width="120" height="60" rx="7" /><rect x="24" y="140" width="120" height="60" rx="7" /><rect x="336" y="40" width="120" height="60" rx="7" /><rect x="336" y="140" width="120" height="60" rx="7" /></g>
            <rect x="164" y="86" width="152" height="68" rx="9" fill="#173f73" />
            <g fontFamily="Manrope, sans-serif" textAnchor="middle" fontSize="12" fontWeight="600"><text x="84" y="76" fill="#263a4f">Purchasing</text><text x="84" y="176" fill="#263a4f">Suppliers</text><text x="396" y="76" fill="#263a4f">Sales</text><text x="396" y="176" fill="#263a4f">Reports</text><text x="240" y="115" fill="#fff">Inventory</text><text x="240" y="135" fill="#c6d7e9" fontSize="10" fontWeight="400">Everything in its place</text></g>
            <g fill="#4c83d5"><circle cx="164" cy="120" r="3" /><circle cx="316" cy="120" r="3" /></g>
          </svg>
          <div className="auth-illustration-footer"><ShieldCheck size={15} /><span>Connected records. Clear decisions.</span></div>
        </div>
        <p className="auth-supporting">Less switching between tools.<br />More time to move your business forward.</p>
      </div>
      <div className="auth-brand-footer"><span>Built for everyday business.</span><Link to="/forgot-password">Account recovery</Link></div>
    </section>
    <main className="erp-auth-main">
      <div className="auth-mobile-brand"><BrandLogoMark size={28} /><strong>SoftdigitIMS</strong></div>
      <Link to="/" className="auth-back"><ArrowLeft size={15} />Back to home</Link>
      <div className="erp-auth-form">{children}</div>
      <footer className="auth-legal"><span>© {new Date().getFullYear()} SoftdigitIMS</span><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link></footer>
    </main>
  </div>;
}
