'use client'

import { SandboxInstance } from "@blaxel/core";
import { SessionWithToken } from "@blaxel/core/sandbox/types";
import { useEffect, useRef, useState } from "react";

// Define a type for processes based on what's returned by sandbox.process.list()
interface Process {
  name?: string;
  command?: string;
  status?: string;
  pid?: string;
  // Add other properties that might be needed
}

export default function Home() {
  const [sandbox, setSandbox] = useState<SandboxInstance | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [processes, setProcesses] = useState<Process[]>([]);
  const [sessionInfo, setSessionInfo] = useState<SessionWithToken | null>(null);
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetchSandbox();
  }, []);

  async function fetchSandbox() {
    try {
      const res = await fetch('/api/sandbox', {
        method: 'GET',
      });
      if (!res.ok) {
        throw new Error('Failed to fetch sessions');
      }
      const {session, preview_url}: {session: SessionWithToken, preview_url: string} = await res.json();
      const sandbox = await SandboxInstance.fromSession(session);

      setPreviewUrl(preview_url);
      setSandbox(sandbox);
      setSessionInfo(session);

      const processList = await sandbox.process.list();
      setProcesses(processList);

      if (!processList.find(p => p.name === "npm-dev")) {
        const result = await sandbox.process.exec({
          name: "npm-dev",
          command: "npm run dev",
          workingDir: "/blaxel/app",
          waitForPorts: [3000],
        });
        console.log(result);
        // Update processes list after starting npm dev
        setProcesses(await sandbox.process.list());
      }

      setLoading(false);
    } catch (error) {
      console.error("Error fetching sandbox:", error);
      setLoading(false);
    }
  }

  async function stopProcess(processId: string | undefined) {
    if (!sandbox || !processId) return;

    try {
      await sandbox.process.stop(processId);
      // Update process list after stopping
      const updatedProcesses = await sandbox.process.list();
      setProcesses(updatedProcesses);
    } catch (error) {
      console.error(`Error stopping process ${processId}:`, error);
    }
  }

  async function killProcess(processId: string | undefined) {
    if (!sandbox || !processId) return;

    try {
      await sandbox.process.kill(processId);
      // Update process list after killing
      const updatedProcesses = await sandbox.process.list();
      setProcesses(updatedProcesses);
    } catch (error) {
      console.error(`Error killing process ${processId}:`, error);
    }
  }

  async function startNpmDev() {
    if (!sandbox) return;

    try {
      await sandbox.process.exec({
        name: "npm-dev",
        command: "npm run dev",
        workingDir: "/blaxel/app",
        waitForPorts: [3000],
      });

      // Update process list after starting npm dev
      const updatedProcesses = await sandbox.process.list();
      setProcesses(updatedProcesses);
    } catch (error) {
      console.error("Error starting npm dev:", error);
    }
  }

  const refreshIframe = () => {
    if (iframeRef.current) {
      // Increment the refresh key to force a re-render
      setRefreshKey(prev => prev + 1);

      // For a more direct refresh approach
      if (iframeRef.current.src) {
        iframeRef.current.src = iframeRef.current.src;
      }
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-[family-name:var(--font-geist-sans)]">
      {loading ? (
        <div className="flex items-center justify-center min-h-screen">
          <div className="animate-pulse flex flex-col items-center">
            <div className="h-12 w-12 rounded-full border-4 border-t-blue-500 border-r-transparent border-b-blue-500 border-l-transparent animate-spin"></div>
            <p className="mt-4 text-lg font-medium">Loading sandbox...</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 min-h-screen">
          {/* Left side - Sandbox Information (1/3) */}
          <div className="col-span-1 p-8 bg-white shadow-lg overflow-auto">
            <h1 className="text-2xl font-bold mb-6 text-blue-700">Sandbox Information</h1>

            <div className="space-y-6">
              <InfoCard title="Preview URL">
                <a
                  href={previewUrl ?? ""}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:text-blue-700 underline flex items-center"
                >
                  {previewUrl}
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </InfoCard>

              <InfoCard title="Session ID">
                <div className="font-mono text-sm bg-gray-100 p-2 rounded overflow-x-auto">
                  {sessionInfo?.name || "N/A"}
                </div>
              </InfoCard>

              <InfoCard title="Processes">
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
              </InfoCard>

              <button
                onClick={() => fetchSandbox()}
                className="mt-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md transition-colors"
              >
                Refresh Sandbox Info
              </button>
            </div>
          </div>

          {/* Right side - Preview Iframe (2/3) */}
          <div className="col-span-2 bg-gray-800 relative">
            {previewUrl ? (
              <div className="absolute inset-0 p-4">
                <div className="relative h-full w-full rounded-lg overflow-hidden shadow-2xl border-4 border-gray-700">
                  <div className="bg-gray-900 h-8 flex items-center px-4">
                    <div className="flex space-x-2">
                      <div className="h-3 w-3 rounded-full bg-red-500"></div>
                      <div className="h-3 w-3 rounded-full bg-yellow-500"></div>
                      <div className="h-3 w-3 rounded-full bg-green-500"></div>
                    </div>
                    <div className="flex-1 text-gray-400 text-sm font-medium text-center">
                      {previewUrl}
                    </div>
                    <button
                      onClick={refreshIframe}
                      className="text-gray-400 hover:text-white p-1 rounded-full transition-colors"
                      title="Refresh preview"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                  </div>

                  <iframe
                    key={refreshKey}
                    ref={iframeRef}
                    src={previewUrl}
                    className="w-full h-[calc(100%-2rem)]"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-white text-xl">No preview available</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// InfoCard component for consistent styling
function InfoCard({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <h3 className="text-lg font-medium text-gray-700 mb-2">{title}</h3>
      {children}
    </div>
  );
}
