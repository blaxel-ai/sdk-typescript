'use client'

import { RefObject } from 'react';

interface Process {
  name?: string;
  command?: string;
  status?: string;
  pid?: string;
}

interface ProcessesTabProps {
  processes: Process[];
  selectedProcessId: string | null;
  processLogs: string[];
  isStreamingLogs: boolean;
  logsEndRef: RefObject<HTMLDivElement | null>;
  onProcessSelect: (processId: string) => void;
  onStartNpmDev: () => void;
  onStopProcess: (pid: string) => void;
  onKillProcess: (pid: string) => void;
}

export function ProcessesTab({
  processes,
  selectedProcessId,
  processLogs,
  isStreamingLogs,
  logsEndRef,
  onProcessSelect,
  onStartNpmDev,
  onStopProcess,
  onKillProcess,
}: ProcessesTabProps) {
  return (
    <div className="h-full flex flex-col p-6" style={{ background: 'var(--background)', overflow: 'auto' }}>
      <div className="rounded-lg p-6 flex-1 flex flex-col" style={{ border: '1px solid var(--border)', background: 'var(--secondary)' }}>
        {/* Process Controls Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {/* Process Selector */}
            <select
              value={selectedProcessId || ''}
              onChange={(e) => onProcessSelect(e.target.value)}
              className="px-4 py-2 rounded-md text-sm border min-w-[250px] cursor-pointer"
              style={{
                background: 'var(--background)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)'
              }}
            >
              <option value="">Select a process...</option>
              {processes.map((process) => (
                <option key={process.pid} value={process.pid || ''}>
                  {process.status === 'running' ? '🟢' : '🔴'} {process.name || 'Unnamed'} (PID: {process.pid})
                </option>
              ))}
            </select>

            {/* Control Buttons */}
            <button
              onClick={onStartNpmDev}
              className="px-4 py-2 rounded-md text-sm transition-colors cursor-pointer"
              style={{ background: 'var(--success)', color: 'var(--primary-foreground)' }}
              title="Start npm dev"
            >
              Start
            </button>

            <button
              onClick={() => selectedProcessId && onStopProcess(selectedProcessId)}
              disabled={!selectedProcessId}
              className="px-4 py-2 rounded-md text-sm transition-colors cursor-pointer disabled:opacity-50"
              style={{ background: 'var(--warning)', color: 'var(--primary-foreground)' }}
              title="Stop selected process"
            >
              Stop
            </button>

            <button
              onClick={() => selectedProcessId && onKillProcess(selectedProcessId)}
              disabled={!selectedProcessId}
              className="px-4 py-2 rounded-md text-sm transition-colors cursor-pointer disabled:opacity-50"
              style={{ background: 'var(--error)', color: 'var(--primary-foreground)' }}
              title="Kill selected process"
            >
              Kill
            </button>
          </div>
        </div>

        {/* Process Details */}
        {selectedProcessId && processes.find(p => p.pid === selectedProcessId) && (
          <div className="mb-4 p-3 rounded-md" style={{ background: 'var(--muted)' }}>
            {(() => {
              const process = processes.find(p => p.pid === selectedProcessId);
              return process ? (
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full`} style={{
                        background: process.status === 'running' ? 'var(--success)' : 'var(--error)'
                      }}></div>
                      <span className="font-medium">{process.name}</span>
                      <span className="text-xs px-2 py-1 rounded" style={{
                        background: 'var(--background)',
                        color: 'var(--muted-foreground)'
                      }}>
                        {process.status}
                      </span>
                    </div>
                    <div className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
                      Command: {process.command}
                    </div>
                  </div>
                  <div className="text-sm font-mono" style={{ color: 'var(--muted-foreground)' }}>
                    PID: {process.pid}
                  </div>
                </div>
              ) : null;
            })()}
          </div>
        )}

        {/* Logs Viewer */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium" style={{ color: 'var(--muted-foreground)' }}>Logs Output</h4>
            {isStreamingLogs && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <div className="h-2 w-2 rounded-full animate-pulse" style={{ background: 'var(--success)' }}></div>
                Streaming...
              </div>
            )}
          </div>

          <div
            className="flex-1 overflow-auto rounded-md p-4 font-mono text-xs"
            style={{
              background: '#1e1e1e',
              color: '#d4d4d4',
              border: '1px solid var(--border)'
            }}
          >
            {processLogs.length === 0 ? (
              <div style={{ color: 'var(--muted-foreground)' }}>
                {selectedProcessId ? 'No logs yet...' : 'Select a process to view logs'}
              </div>
            ) : (
              <>
                {processLogs.map((log, index) => (
                  <div key={index} className="whitespace-pre-wrap break-all">
                    {log}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </>
            )}
          </div>
        </div>

        {/* Process Summary */}
        {processes.length === 0 && (
          <div className="text-center py-8">
            <p className="text-lg mb-4" style={{ color: 'var(--muted-foreground)' }}>
              No processes running
            </p>
            <button
              onClick={onStartNpmDev}
              className="px-6 py-3 rounded-md transition-colors flex items-center mx-auto cursor-pointer"
              style={{ background: 'var(--success)', color: 'var(--primary-foreground)' }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Start npm run dev
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
