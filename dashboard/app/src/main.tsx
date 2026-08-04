import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import App from './App'
import GlobalView from './views/GlobalView'
import ProjectView from './views/ProjectView'
import AgentsConfigView from './views/AgentsConfigView'
import FlowVizView from './views/FlowVizView'
import '@xyflow/react/dist/style.css'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<GlobalView />} />
          <Route path="project/:id" element={<ProjectView />} />
          <Route path="agents" element={<AgentsConfigView />} />
          <Route path="flows/viz" element={<FlowVizView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
