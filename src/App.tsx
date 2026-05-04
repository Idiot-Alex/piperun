import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import TokenGate from './components/TokenGate';

const PipelinesPage = lazy(() => import('./pages/PipelinesPage'));
const EditorPage = lazy(() => import('./pages/EditorPage'));
const RunPage = lazy(() => import('./pages/RunPage'));

function PageFallback() {
  return (
    <div className="flex justify-center items-center min-h-screen bg-base-100">
      <span className="loading loading-spinner loading-lg text-primary"></span>
    </div>
  );
}

const router = createBrowserRouter([
  { path: '/', element: <PipelinesPage /> },
  { path: '/new', element: <EditorPage /> },
  { path: '/edit/:id', element: <EditorPage /> },
  { path: '/run/:id', element: <RunPage /> },
]);

export default function App() {
  return (
    <TokenGate>
      <Suspense fallback={<PageFallback />}>
        <RouterProvider router={router} />
      </Suspense>
    </TokenGate>
  );
}
