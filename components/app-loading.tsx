export function AppLoading() {
  return (
    <div className="fixed inset-0 z-50 flex min-h-screen items-center justify-center overflow-hidden bg-gray-50 px-6 dark:bg-gray-950">
      <div
        role="status"
        aria-live="polite"
        className="relative flex w-full max-w-xs flex-col items-center"
      >
        <div className="relative mb-6 flex h-20 w-20 items-center justify-center">
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-[22px] border border-gray-200 dark:border-gray-800"
          />
          <span
            aria-hidden="true"
            className="absolute -inset-1 rounded-[26px] border border-transparent border-r-blue-300/70 border-t-blue-500 animate-spin [animation-duration:1.25s] motion-reduce:animate-none dark:border-r-blue-800 dark:border-t-blue-400"
          />
          <span
            aria-hidden="true"
            className="absolute -inset-3 rounded-[34px] border border-transparent border-b-gray-300/70 animate-[spin_2.2s_linear_infinite_reverse] motion-reduce:animate-none dark:border-b-gray-700"
          />
          <span
            aria-hidden="true"
            className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-900 text-xl font-semibold text-white shadow-sm dark:bg-gray-100 dark:text-gray-950"
          >
            D
          </span>
        </div>

        <div className="space-y-1 text-center">
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Ditto
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            正在准备工作区
          </p>
        </div>

        <div className="mt-6 h-1.5 w-48 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
          <div className="h-full w-1/2 rounded-full bg-blue-500 animate-loading-sweep motion-reduce:animate-none" />
        </div>

        <div className="mt-4 flex items-center gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-pulse motion-reduce:animate-none dark:bg-gray-600"
              style={{ animationDelay: `${index * 140}ms` }}
            />
          ))}
        </div>
        <span className="sr-only">加载中</span>
      </div>
    </div>
  );
}
