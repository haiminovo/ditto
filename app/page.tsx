"use client";

import { useState } from "react";
import { useApp } from "./providers";
import { SetupPage } from "@/components/setup";
import { ChatPage } from "@/components/chat";

export default function Home() {
  const { isLoading, isConfigured } = useApp();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4" />
          <p className="text-gray-500 dark:text-gray-400">加载中...</p>
        </div>
      </div>
    );
  }

  if (!isConfigured) {
    return <SetupPage />;
  }

  return <ChatPage />;
}
