import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import App from './App'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    // 탐색기 목록은 직접 새로고침할 때까지 그대로 (DB에 매번 묻지 않게)
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
