"use client";

import { useState } from "react";
import { useApp } from "./providers";
import { SetupPage } from "@/components/setup";
import { ChatPage } from "@/components/chat";
import { AppLoading } from "@/components/app-loading";

export default function Home() {
  const { isLoading, isConfigured } = useApp();

  if (isLoading) {
    return <AppLoading />;
  }

  if (!isConfigured) {
    return <SetupPage />;
  }

  return <ChatPage />;
}
