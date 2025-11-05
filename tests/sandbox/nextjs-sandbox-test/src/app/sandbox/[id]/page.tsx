'use client'

import { Chatbot } from "@/lib/components/Chatbot";
import { CodeViewerTab } from "@/lib/components/CodeViewerTab";
import { PreviewTab } from "@/lib/components/PreviewTab";
import { ProcessesTab } from "@/lib/components/ProcessesTab";
import { TerminalTab } from "@/lib/components/TerminalTab";
import { SandboxInstance } from "@blaxel/core";
// Removed SessionWithToken import to avoid type dependency
import { useRouter } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";

// Define a type for processes
interface Process {
  name?: string;
  command?: string;
  status?: string;
  pid?: string;
}

// Removed auth: no user model here

// Minimal type for Blaxel sandboxes
interface BlaxelSandbox {
  metadata: {
    name: string;
  };
  status: 'DELETING' | 'FAILED' | 'DEACTIVATING' | 'DEPLOYING' | 'DEPLOYED';
}

export default function SandboxPage({ params }: { params: Promise<{ id: string }> }) {
  const [sandbox, setSandbox] = useState<BlaxelSandbox | null>(null);
  const [sandboxInstance, setSandboxInstance] = useState<SandboxInstance | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [sessionInfo, setSessionInfo] = useState<{ name?: string } | null>(null);
  // Removed auth state
  const [error, setError] = useState<string | null>(null);
  const [isLoadingSandbox, setIsLoadingSandbox] = useState<boolean>(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'preview' | 'processes' | 'code' | 'terminal'>('preview');
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [processLogs, setProcessLogs] = useState<string[]>([]);
  const [isStreamingLogs, setIsStreamingLogs] = useState<boolean>(false);
  const logStreamRef = useRef<{ close: () => void } | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const hasFetchedRef = useRef<boolean>(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const router = useRouter();



  useEffect(() => {
    if (!hasFetchedRef.current && !isLoadingSandbox) {
      hasFetchedRef.current = true;
      fetchSandbox();
    }
  }, [isLoadingSandbox]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Simplified preview loading and refresh logic
  async function refreshPreview() {
    if (!previewUrl) return;
    setIsPreviewLoading(true);
    try {
      const res = await fetch(previewUrl, { method: 'GET' });
      if (res.ok) {
        setIsPreviewLoading(false);
      } else {
        setIsPreviewLoading(true);
        setTimeout(refreshPreview, 1000);
      }
    } catch {
      setIsPreviewLoading(true);
    }
  }

  // Call refreshPreview on previewUrl change
  useEffect(() => {
    if (previewUrl) {
      refreshPreview();
    }
  }, [previewUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set loading state when npm-dev process starts or changes
  useEffect(() => {
    const npmDevProcess = processes.find(p => p.name === "npm-dev");
    if (npmDevProcess) {
      // If the process is just starting, set loading to true
      if (npmDevProcess.status === "starting") {
        setIsPreviewLoading(true);
      }
    }
  }, [processes]);

  // Removed auth-related functions

  async function fetchSandbox() {
    if (isLoadingSandbox) return; // Prevent concurrent calls

    setIsLoadingSandbox(true);
    setError(null);
    setIsPreviewLoading(true); // Set preview as loading when fetching sandbox
    try {
      const { id } = (await params) as { id: string };
      const res = await fetch(`/api/sandboxes/${id}`);

      if (!res.ok) {
        throw new Error('Failed to fetch sandbox');
      }

      const data = await res.json();
      setSandbox({ metadata: data.metadata, status: data.status });
      try {
        const sandboxInstance = await SandboxInstance.fromSession(data.session);

        setPreviewUrl(data.preview_url);
        setSandboxInstance(sandboxInstance);
        setSessionInfo(data.session);

        const processList = await sandboxInstance.process.list();
        setProcesses(processList);

        // Check if npm-dev is already running
        const npmDevRunning = processList.some(p => p.name === "npm-dev" && p.status === "running");

        if (!npmDevRunning) {
          console.log('Starting npm-dev process...');
          setIsPreviewLoading(true);
          const result = await sandboxInstance.process.exec({
            name: "npm-dev",
            command: "npm run dev",
            workingDir: "/blaxel/app",
            waitForPorts: [3000],
          });
          console.log('npm-dev process started:', result);
          // Update processes list after starting npm dev
          setProcesses(await sandboxInstance.process.list());
        } else {
          console.log('npm-dev process is already running');
        }
      } catch (err) {
        console.error('Error with sandbox initialization:', err);
        setError(`Failed to initialize sandbox: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    } catch (error) {
      console.error("Error fetching sandbox:", error);
      setError(`Failed to fetch sandbox: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  }

  async function stopProcess(processId: string | undefined) {
    if (!sandboxInstance || !processId) return;

    try {
      await sandboxInstance.process.stop(processId);
      // Update process list after stopping
      const updatedProcesses = await sandboxInstance.process.list();
      setProcesses(updatedProcesses);
    } catch (error) {
      console.error(`Error stopping process ${processId}:`, error);
    }
  }

  async function killProcess(processId: string | undefined) {
    if (!sandboxInstance || !processId) return;

    try {
      await sandboxInstance.process.kill(processId);
      // Update process list after killing
      const updatedProcesses = await sandboxInstance.process.list();
      setProcesses(updatedProcesses);
    } catch (error) {
      console.error(`Error killing process ${processId}:`, error);
    }
  }

  async function startNpmDev() {
    if (!sandboxInstance) return;

    try {
      await sandboxInstance.process.exec({
        name: "npm-dev",
        command: "npm run dev",
        workingDir: "/blaxel/app",
        waitForPorts: [3000],
      });

      // Update process list after starting npm dev
      const updatedProcesses = await sandboxInstance.process.list();
      setProcesses(updatedProcesses);
    } catch (error) {
      console.error("Error starting npm dev:", error);
    }
  }

  // Return to sandboxes list
  const backToList = () => {
    router.push('/');
  };

  // Handle process selection and start streaming logs
  const handleProcessSelection = (processId: string) => {
    // Stop any existing log stream
    if (logStreamRef.current) {
      logStreamRef.current.close();
      logStreamRef.current = null;
    }

    setSelectedProcessId(processId);
    setProcessLogs([]);

    if (processId && sandboxInstance && sandboxInstance.process && typeof sandboxInstance.process.streamLogs === 'function') {
      setIsStreamingLogs(true);
      try {
        const stream = sandboxInstance.process.streamLogs(processId, {
          onLog: (log: string) => {
            const lines = log.split('\n').filter(line => line.trim());
            if (lines.length > 0) {
              setProcessLogs((prevLogs: string[]) => [...prevLogs, ...lines]);
            }
          }
        });
        logStreamRef.current = stream;
      } catch (error) {
        console.error('Error streaming logs:', error);
        setIsStreamingLogs(false);
      }
    }
  };

  // Clean up log stream on unmount or tab change
  useEffect(() => {
    return () => {
      if (logStreamRef.current) {
        logStreamRef.current.close();
        logStreamRef.current = null;
      }
    };
  }, [activeTab]);

  // Refresh processes list when Processes tab is selected or when switching tabs
  useEffect(() => {
    if (sandboxInstance) {
      const refreshProcesses = async () => {
        try {
          const processList = await sandboxInstance.process.list();
          setProcesses(processList);
        } catch (error) {
          console.error('Error fetching processes:', error);
        }
      };

      // Refresh immediately when tab changes or sandboxInstance changes
      refreshProcesses();

      // Set up periodic refresh every 2 seconds only while on Processes tab
      if (activeTab === 'processes') {
        const interval = setInterval(refreshProcesses, 2000);
        return () => clearInterval(interval);
      }
    }
  }, [activeTab, sandboxInstance]);

  // Auto-scroll to bottom when new logs arrive (only within log container)
  useEffect(() => {
    if (logsEndRef.current && activeTab === 'processes') {
      // Scroll only the log container, not the entire page
      const logContainer = logsEndRef.current.closest('.overflow-auto');
      if (logContainer) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    }
  }, [processLogs, activeTab]);

  return (
    <div className="min-h-screen font-sans" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
      {loading ? (
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-pulse flex flex-col items-center">
            <div className="h-12 w-12 rounded-full border-4 animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--primary)', borderRightColor: 'transparent', borderBottomColor: 'var(--primary)', borderLeftColor: 'transparent' }}></div>
            <p className="mt-4 text-lg font-medium">Loading apps...</p>
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center min-h-screen">
          <div className="max-w-md p-6 rounded-lg shadow-lg text-center" style={{ background: 'var(--secondary)', color: 'var(--secondary-foreground)', border: '1px solid var(--border)' }}>
            <div className="mb-4" style={{ color: 'var(--error)' }}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold mb-2">Error Loading App</h2>
            <p className="mb-6" style={{ color: 'var(--muted-foreground)' }}>{error}</p>
            <div className="flex justify-center space-x-4">
              <button
                onClick={() => {
                  setError(null);
                  hasFetchedRef.current = false;
                  fetchSandbox();
                }}
                className="px-4 py-2 rounded-md transition-colors cursor-pointer"
                style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
              >
                Try Again
              </button>
              <button
                onClick={backToList}
                className="px-4 py-2 rounded-md transition-colors cursor-pointer"
                style={{ color: 'var(--foreground)' }}
              >
                Back to List
              </button>
            </div>
          </div>
        </div>
            ) : (
        <div className="grid grid-cols-3 h-screen">
          {/* Left sidebar - Sandbox Information (1/3) */}
          <div className="col-span-1 p-6 shadow-lg flex flex-col h-full overflow-hidden" style={{ background: 'var(--secondary)', color: 'var(--secondary-foreground)', borderRight: '1px solid var(--border)' }}>
            <div className="flex justify-between items-center mb-4">
              <h1 className="text-2xl font-bold" style={{ color: 'var(--primary)' }}>{sandbox?.metadata?.name || 'App'}</h1>
              <div className="flex gap-2">
                <button
                  onClick={backToList}
                  className="px-3 py-1 rounded-md text-sm transition-colors flex items-center cursor-pointer hover:bg-blue-400"
                  style={{ color: 'var(--foreground)' }}
                >
                  Back to List
                </button>
                {/* Removed Logout */}
              </div>
            </div>

            {/* Chatbot section - main content */}
            <div className="flex-grow mb-4 overflow-hidden flex flex-col">
              <InfoCard title="App Builder Assistant" className="flex-grow flex flex-col h-full overflow-hidden">
                {sandbox && <Chatbot sandboxName={sandbox?.metadata?.name ?? 'unknown'} className="flex-grow" />}
              </InfoCard>
            </div>

            {/* App information section */}
            <div className="space-y-3">
              {/* No user info */}

              {sandbox && (
                <InfoCard title="App Details">
                  <div className="space-y-1">
                    <div>
                      <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>Name:</span>
                      <span className="text-xs ml-2">{sandbox.metadata?.name}</span>
                    </div>
                    <div>
                      <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>Session:</span>
                      <span className="text-xs ml-2 font-mono">{sessionInfo?.name || "N/A"}</span>
                    </div>
                    <div>
                      <span className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>Status:</span>
                      <span className="text-xs ml-2">{sandbox.status}</span>
                    </div>
                  </div>
                </InfoCard>
              )}

              {previewUrl && (
                <InfoCard title="Preview URL">
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline flex items-center text-sm"
                    style={{ color: 'var(--primary)' }}
                  >
                    Open in new tab
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </InfoCard>
              )}
            </div>
          </div>

          {/* Right side - Tabbed Content (2/3) */}
          <div className="col-span-2 flex flex-col h-full overflow-hidden" style={{ background: 'var(--background)' }}>
            {/* Tab Navigation */}
            <div className="flex border-b" style={{ background: 'var(--background)', borderColor: 'var(--border)' }}>
              <button
                onClick={() => setActiveTab('preview')}
                className={`px-6 py-3 font-medium transition-colors ${activeTab === 'preview' ? 'border-b-2' : ''}`}
                style={{
                  borderColor: activeTab === 'preview' ? 'var(--primary)' : 'transparent',
                  color: activeTab === 'preview' ? 'var(--primary)' : 'var(--muted-foreground)'
                }}
              >
                Preview
              </button>
              <button
                onClick={() => setActiveTab('processes')}
                className={`px-6 py-3 font-medium transition-colors ${activeTab === 'processes' ? 'border-b-2' : ''}`}
                style={{
                  borderColor: activeTab === 'processes' ? 'var(--primary)' : 'transparent',
                  color: activeTab === 'processes' ? 'var(--primary)' : 'var(--muted-foreground)'
                }}
              >
                Processes
              </button>
                            <button
                onClick={() => setActiveTab('code')}
                className={`px-6 py-3 font-medium transition-colors ${activeTab === 'code' ? 'border-b-2' : ''}`}
                style={{
                  borderColor: activeTab === 'code' ? 'var(--primary)' : 'transparent',
                  color: activeTab === 'code' ? 'var(--primary)' : 'var(--muted-foreground)'
                }}
              >
                Code Viewer
              </button>
              <button
                onClick={() => setActiveTab('terminal')}
                className={`px-6 py-3 font-medium transition-colors ${activeTab === 'terminal' ? 'border-b-2' : ''}`}
                style={{
                  borderColor: activeTab === 'terminal' ? 'var(--primary)' : 'transparent',
                  color: activeTab === 'terminal' ? 'var(--primary)' : 'var(--muted-foreground)'
                }}
              >
                Terminal
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden">
              {activeTab === 'preview' ? (
                <PreviewTab
                  previewUrl={previewUrl}
                  isPreviewLoading={isPreviewLoading}
                  iframeRef={iframeRef}
                  onRefresh={refreshPreview}
                />
              ) : activeTab === 'processes' ? (
                <ProcessesTab
                  processes={processes}
                  selectedProcessId={selectedProcessId}
                  processLogs={processLogs}
                  isStreamingLogs={isStreamingLogs}
                  logsEndRef={logsEndRef}
                  onProcessSelect={handleProcessSelection}
                  onStartNpmDev={startNpmDev}
                  onStopProcess={stopProcess}
                  onKillProcess={killProcess}
                />
              ) : activeTab === 'code' ? (
                <CodeViewerTab sandboxInstance={sandboxInstance} />
              ) : (
                <TerminalTab sandboxInstance={sandboxInstance} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// InfoCard component for consistent styling
function InfoCard({ title, children, className }: { title: string, children: React.ReactNode, className?: string }) {
  return (
    <div className={`rounded-lg p-4 ${className || ''}`} style={{ border: '1px solid var(--border)', background: 'var(--background)' }}>
      <h3 className="text-lg font-medium mb-2" style={{ color: 'var(--muted-foreground)' }}>{title}</h3>
      {children}
    </div>
  );
}

