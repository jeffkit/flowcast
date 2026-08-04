import { Outlet, Link, NavLink } from 'react-router-dom'

// 顶层布局：固定 header + 内容容器。子路由（GlobalView / ProjectView）由 Outlet 渲染。
export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-icon">📊</span>
          <span className="brand-text">Flowcast Dashboard</span>
        </Link>
        <nav className="topnav">
          <NavLink to="/" className={({ isActive }) => isActive ? 'topnav-link active' : 'topnav-link'} end>
            项目
          </NavLink>
          <NavLink to="/agents" className={({ isActive }) => isActive ? 'topnav-link active' : 'topnav-link'}>
            Agent 配置
          </NavLink>
          <NavLink to="/flows/viz" className={({ isActive }) => isActive ? 'topnav-link active' : 'topnav-link'}>
            Flow 可视化
          </NavLink>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
