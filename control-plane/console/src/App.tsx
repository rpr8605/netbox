import { Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar.tsx'
import Board from './screens/Board.tsx'

function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        <Routes>
          <Route path="/" element={<Board />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
