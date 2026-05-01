import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import PipelinesPage from './pages/PipelinesPage';
import EditorPage from './pages/EditorPage';
import RunPage from './pages/RunPage';

const router = createBrowserRouter([
  { path: '/', element: <PipelinesPage /> },
  { path: '/new', element: <EditorPage /> },
  { path: '/edit/:id', element: <EditorPage /> },
  { path: '/run/:id', element: <RunPage /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
