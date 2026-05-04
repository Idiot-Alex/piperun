import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import PipelinesPage from './pages/PipelinesPage';
import EditorPage from './pages/EditorPage';
import RunPage from './pages/RunPage';
import TokenGate from './components/TokenGate';

const router = createBrowserRouter([
  { path: '/', element: <PipelinesPage /> },
  { path: '/new', element: <EditorPage /> },
  { path: '/edit/:id', element: <EditorPage /> },
  { path: '/run/:id', element: <RunPage /> },
]);

export default function App() {
  return (
    <TokenGate>
      <RouterProvider router={router} />
    </TokenGate>
  );
}
