'use client'

import { Chatbot } from "@/lib/components/Chatbot";
import { Sandbox } from "@/lib/db/schema";
import { SandboxInstance } from "@blaxel/core";
import { SessionWithToken } from "@blaxel/core/sandbox/types";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Define a type for processes
interface Process {
  name?: string;
  command?: string;
  status?: string;
  pid?: string;
}

interface User {
  id: number;
  email: string;
}

export default function SandboxPage({ params }: { params: { id: string } }) {
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [sandboxInstance, setSandboxInstance] = useState<SandboxInstance | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [sessionInfo, setSessionInfo] = useState<SessionWithToken | null>(null);
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingSandbox, setIsLoadingSandbox] = useState<boolean>(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState<boolean>(true);
  const hasFetchedRef = useRef<boolean>(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const router = useRouter();



  useEffect(() => {
    // Check if user is authenticated
    checkAuth();
  }, []);

  useEffect(() => {
    // Only fetch sandbox once when user is authenticated
    if (authChecked && user && !hasFetchedRef.current && !isLoadingSandbox) {
      hasFetchedRef.current = true;
      fetchSandbox();
    }
  }, [authChecked, user, isLoadingSandbox]);

  useEffect(() => {
    // Reset loading state when preview URL changes
    if (previewUrl) {
      setIsPreviewLoading(true);
    }
  }, [previewUrl]);

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

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/user');
      if (res.status === 401) {
        // User is not authenticated, redirect to login
        router.push('/login');
        return;
      }

      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setUser(data.user);
        } else {
          router.push('/login');
        }
      }
    } catch (error) {
      console.error("Auth check error:", error);
      router.push('/login');
    } finally {
      setAuthChecked(true);
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
      });
      router.push('/login');
    } catch (error) {
      console.error("Logout error:", error);
    }
  }

  async function fetchSandbox() {
    if (isLoadingSandbox) return; // Prevent concurrent calls

    setIsLoadingSandbox(true);
    setError(null);
    setIsPreviewLoading(true); // Set preview as loading when fetching sandbox

    try {
      const p = await params;
      const res = await fetch(`/api/sandboxes/${p.id}`);

      if (!res.ok) {
        throw new Error('Failed to fetch sandbox');
      }

      const data = await res.json();
      setSandbox(data.sandbox);

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
        setIsPreviewLoading(false);
      }
    } catch (error) {
      console.error("Error fetching sandbox:", error);
      setError(`Failed to fetch sandbox: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setIsPreviewLoading(false);
    } finally {
      setLoading(false);
      setIsLoadingSandbox(false);
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

  const refreshIframe = () => {
    if (iframeRef.current) {
      // Set loading state when refreshing
      setIsPreviewLoading(true);

      // Increment the refresh key to force a re-render
      setRefreshKey(prev => prev + 1);

      // For a more direct refresh approach
      if (iframeRef.current.src) {
        iframeRef.current.src = iframeRef.current.src;
      }
    }
  };

  // Handle iframe load event
  const handleIframeLoad = () => {
    setIsPreviewLoading(false);
  };

  // Manual refresh function that can be called from button
  const manualRefresh = () => {
    hasFetchedRef.current = false; // Reset the fetch flag
    fetchSandbox();
  };

  // Return to sandboxes list
  const backToList = () => {
    router.push('/');
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      {loading ? (
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-pulse flex flex-col items-center">
            <div className="h-12 w-12 rounded-full border-4 border-t-blue-500 border-r-transparent border-b-blue-500 border-l-transparent animate-spin"></div>
            <p className="mt-4 text-lg font-medium">Loading sandbox...</p>
          </div>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center min-h-screen">
          <div className="max-w-md p-6 bg-white rounded-lg shadow-lg text-center">
            <div className="text-red-500 mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold mb-2">Error Loading Sandbox</h2>
            <p className="text-gray-600 mb-6">{error}</p>
            <div className="flex justify-center space-x-4">
              <button
                onClick={() => {
                  setError(null);
                  hasFetchedRef.current = false;
                  fetchSandbox();
                }}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={backToList}
                className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-md transition-colors"
              >
                Back to List
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 h-screen">
          {/* Left side - Sandbox Information (1/3) */}
          <div className="col-span-1 p-6 bg-white shadow-lg flex flex-col h-full overflow-hidden">
            <div className="flex justify-between items-center mb-4">
              <h1 className="text-2xl font-bold text-blue-700">{sandbox?.name || 'Sandbox'}</h1>
              <div className="flex gap-2">
                <button
                  onClick={backToList}
                  className="bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-1 rounded-md text-sm transition-colors flex items-center"
                >
                  Back to List
                </button>
                <button
                  onClick={logout}
                  className="bg-gray-200 hover:bg-gray-300 text-gray-700 px-3 py-1 rounded-md text-sm transition-colors"
                >
                  Logout
                </button>
              </div>
            </div>

            {/* Chatbot section - 70% of the height */}
            <div className="flex-grow h-[70%] mb-3 overflow-hidden flex flex-col">
              <InfoCard title="Sandbox Assistant" className="flex-grow flex flex-col h-full overflow-hidden">
                {sandboxInstance && <Chatbot sandbox={sandboxInstance} className="flex-grow" />}
              </InfoCard>
            </div>

            {/* Sandbox info - 30% of the height */}
            <div className="h-[28%] overflow-auto">
              {/* User and sandbox basic info in a more compact layout */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                {user && (
                  <InfoCard title="User">
                    <div className="flex flex-col">
                      <span className="text-sm text-gray-600">{user.email}</span>
                    </div>
                  </InfoCard>
                )}

                <InfoCard title="Preview URL">
                  <a
                    href={previewUrl ?? ""}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:text-blue-700 underline flex items-center"
                  >
                    {previewUrl ? 'Open Preview' : 'No preview URL'}
                    {previewUrl && (
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    )}
                  </a>
                </InfoCard>
              </div>

              {/* Collapsible sections with proper spacing */}
              <div className="space-y-4 mb-4">
                <Collapsible title="Sandbox Details" defaultOpen={false}>
                  {sandbox && (
                    <div className="flex flex-col space-y-2">
                      <div>
                        <span className="text-sm font-medium text-gray-600">ID:</span>
                        <span className="text-sm ml-2">{sandbox.id}</span>
                      </div>
                      <div>
                        <span className="text-sm font-medium text-gray-600">Description:</span>
                        <span className="text-sm ml-2">{sandbox.description || 'No description'}</span>
                      </div>
                      <div>
                        <span className="text-sm font-medium text-gray-600">Created:</span>
                        <span className="text-sm ml-2">{sandbox.createdAt ? new Date(sandbox.createdAt).toLocaleString() : 'N/A'}</span>
                      </div>
                      <div>
                        <span className="text-sm font-medium text-gray-600">Last Accessed:</span>
                        <span className="text-sm ml-2">{sandbox.lastAccessedAt ? new Date(sandbox.lastAccessedAt).toLocaleString() : 'N/A'}</span>
                      </div>
                      <div>
                        <span className="text-sm font-medium text-gray-600">Session ID:</span>
                        <span className="text-sm ml-2 font-mono">{sessionInfo?.name || "N/A"}</span>
                      </div>
                    </div>
                  )}
                </Collapsible>

                <Collapsible title="Processes" defaultOpen={false}>
                  <div className="space-y-2">
                    {processes.length === 0 ? (
                      <div>
                        <p className="text-gray-500 italic mb-4">No processes running</p>
                        <button
                          onClick={startNpmDev}
                          className="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded-md text-sm transition-colors flex items-center"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          Start npm run dev
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex justify-end mb-2">
                          <button
                            onClick={startNpmDev}
                            className="bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded-md text-xs transition-colors flex items-center"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            Start npm run dev
                          </button>
                        </div>
                        {processes.map((process, idx) => (
                          <div key={idx} className="bg-gray-100 p-3 rounded-md">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center">
                                <div className={`h-2 w-2 rounded-full mr-2 ${process.status === 'running' ? 'bg-green-500' : 'bg-gray-500'}`}></div>
                                <span className="font-medium">{process.name}</span>
                              </div>
                              <div className="flex space-x-2">
                                <button
                                  onClick={() => stopProcess(process.pid)}
                                  className="bg-orange-500 hover:bg-orange-600 text-white px-2 py-1 rounded-md text-xs transition-colors"
                                  title="Stop process"
                                >
                                  Stop
                                </button>
                                <button
                                  onClick={() => killProcess(process.pid)}
                                  className="bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded-md text-xs transition-colors flex items-center"
                                  title="Kill process"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                  Kill
                                </button>
                              </div>
                            </div>
                            <div className="text-sm text-gray-600 mt-1">Command: {process.command}</div>
                            <div className="text-xs text-gray-500 mt-1">PID: {process.pid}</div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </Collapsible>

                <button
                  onClick={manualRefresh}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md transition-colors flex items-center justify-center gap-2 w-full"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh Sandbox Info
                </button>
              </div>
            </div>
          </div>

          {/* Right side - Preview Iframe (2/3) */}
          <div className="col-span-2 bg-gray-800 relative h-full overflow-hidden">
            {previewUrl ? (
              <div className="absolute inset-0 p-4">
                <div className="relative h-full w-full rounded-lg overflow-hidden shadow-2xl border-4 border-gray-700">
                  <div className="bg-gray-900 h-8 flex items-center px-4">
                    <div className="flex space-x-2">
                      <div className="h-3 w-3 rounded-full bg-red-500"></div>
                      <div className="h-3 w-3 rounded-full bg-yellow-500"></div>
                      <div className="h-3 w-3 rounded-full bg-green-500"></div>
                    </div>
                    <div className="flex-1 text-gray-400 text-sm font-medium text-center truncate px-4">
                      {previewUrl}
                    </div>
                    <button
                      onClick={refreshIframe}
                      className="text-gray-400 hover:text-white p-1 rounded-full transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  </div>

                  {/* Loading overlay for preview */}
                  {isPreviewLoading && (
                    <div className="absolute inset-0 bg-gray-900 bg-opacity-70 z-10 flex flex-col items-center justify-center">
                      <div className="h-12 w-12 rounded-full border-4 border-t-blue-500 border-r-transparent border-b-blue-500 border-l-transparent animate-spin"></div>
                      <p className="mt-4 text-white text-sm">Loading preview...</p>
                    </div>
                  )}

                  <iframe
                    key={refreshKey}
                    ref={iframeRef}
                    src={previewUrl}
                    className="w-full h-[calc(100%-32px)]"
                    title="Sandbox Preview"
                    onLoad={handleIframeLoad}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                No preview available
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// InfoCard component for consistent styling
function InfoCard({ title, children, className }: { title: string, children: React.ReactNode, className?: string }) {
  return (
    <div className={`border border-gray-200 rounded-lg p-4 ${className || ''}`}>
      <h3 className="text-lg font-medium text-gray-700 mb-2">{title}</h3>
      {children}
    </div>
  );
}

function Collapsible({ title, defaultOpen, children }: { title: string, defaultOpen: boolean, children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex justify-between items-center mb-2">
        <h4 className="text-lg font-medium text-gray-700">{title}</h4>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="text-gray-500 hover:text-gray-900 p-1 rounded-full transition-colors"
        >
          {isOpen ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </button>
      </div>
      {isOpen && children}
    </div>
  );
}