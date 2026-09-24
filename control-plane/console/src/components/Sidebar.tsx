import { Link } from 'react-router-dom'
import { ROUTES } from '../routes.tsx'

export default function Sidebar() {
  return (
    <nav className="sidebar" style={{ width: 240, background: 'var(--sidebar)', color: 'var(--sidebar-text)' }}>
      <div className="sidebar-header" style={{ padding: 20 }}>
        <strong>Beacon Relay</strong>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Service desk</div>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <li><Link to={ROUTES.board} style={{ display: 'block', padding: '12px 20px', color: 'inherit', textDecoration: 'none' }}>Master board</Link></li>
        <li><Link to={ROUTES.alerts} style={{ display: 'block', padding: '12px 20px', color: 'inherit', textDecoration: 'none' }}>Alerts</Link></li>
        <li><Link to={ROUTES.fleet} style={{ display: 'block', padding: '12px 20px', color: 'inherit', textDecoration: 'none' }}>Fleet</Link></li>
      </ul>
    </nav>
  )
}
