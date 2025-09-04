'use client'

import { SandboxInstance } from '@blaxel/core';
import { useEffect, useRef, useState } from 'react';

interface CommandHistory {
  command: string;
  output: string[];
  timestamp: Date;
  status: 'running' | 'completed' | 'failed';
  pid?: string;
}

interface TerminalTabProps {
  sandboxInstance: SandboxInstance | null;
}

export function TerminalTab({ sandboxInstance }: TerminalTabProps) {
  const [currentCommand, setCurrentCommand] = useState<string>('');
  const [commandHistory, setCommandHistory] = useState<CommandHistory[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [currentPid, setCurrentPid] = useState<string | null>(null);
  const [workingDir, setWorkingDir] = useState<string>('/blaxel/app');

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamControlRef = useRef<{ close: () => void } | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [commandHistory]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Global keyboard handler for Ctrl+C
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Kill process on Ctrl+C when executing
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && isExecuting && currentPid && sandboxInstance) {
        e.preventDefault();
        console.log('Killing process:', currentPid);
        sandboxInstance.process.kill(currentPid);
        if (streamControlRef.current) {
          streamControlRef.current.close();
          streamControlRef.current = null;
        }

        // Update the command history to show it was interrupted
        setCommandHistory(prev => {
          const updated = [...prev];
          const lastCommand = updated[updated.length - 1];
          if (lastCommand && lastCommand.status === 'running') {
            lastCommand.status = 'failed';
            lastCommand.output.push('^C');
          }
          return updated;
        });

        setIsExecuting(false);
        setCurrentPid(null);
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isExecuting, currentPid, sandboxInstance]);

  // Get current time in terminal format
  const getTimeString = () => {
    const now = new Date();
    return now.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Execute command
  const executeCommand = async (command: string) => {
    if (!sandboxInstance || !command.trim()) return;

    setIsExecuting(true);
    setCurrentCommand('');

    const newHistory: CommandHistory = {
      command,
      output: [],
      timestamp: new Date(),
      status: 'running'
    };

    setCommandHistory(prev => [...prev, newHistory]);
    const historyIndex = commandHistory.length;

    try {
      // Handle special commands
      if (command.startsWith('cd ')) {
        const newDir = command.substring(3).trim();
        const absolutePath = newDir.startsWith('/') ? newDir : `${workingDir}/${newDir}`;
        setWorkingDir(absolutePath.replace(/\/+/g, '/'));
        newHistory.output = [`Changed directory to: ${absolutePath}`];
        newHistory.status = 'completed';
        setCommandHistory(prev => {
          const updated = [...prev];
          updated[historyIndex] = newHistory;
          return updated;
        });
        setIsExecuting(false);
        return;
      }

      if (command === 'clear') {
        setCommandHistory([]);
        setIsExecuting(false);
        return;
      }

      if (command === 'pwd') {
        newHistory.output = [workingDir];
        newHistory.status = 'completed';
        setCommandHistory(prev => {
          const updated = [...prev];
          updated[historyIndex] = newHistory;
          return updated;
        });
        setIsExecuting(false);
        return;
      }

      // Execute command in sandbox
      const outputLines: string[] = [];

      const result = await sandboxInstance.process.exec({
        command,
        workingDir,
        waitForCompletion: false
      });

      newHistory.pid = result.pid;
      setCurrentPid(result.pid);

      // Stream logs
      if (result.pid) {
        streamControlRef.current = sandboxInstance.process.streamLogs(result.pid, {
          onLog: (log: string) => {
            const lines = log.split('\n');
                        lines.forEach(line => {
              if (line.trim()) {
                outputLines.push(line);

                // Update history with new output
                setCommandHistory(prev => {
                  const updated = [...prev];
                  if (updated[historyIndex]) {
                    updated[historyIndex].output = [...outputLines];
                  }
                  return updated;
                });
              }
            });
          }
        });

        // Wait for process to complete (24 hours max)
        const processResult = await sandboxInstance.process.wait(result.pid, {
          maxWait: 86400000, // 24 hours in milliseconds
          interval: 500
        });

        // Stop streaming
        if (streamControlRef.current) {
          streamControlRef.current.close();
          streamControlRef.current = null;
        }

        // Update status based on exit code
        newHistory.status = processResult.exitCode === 0 ? 'completed' : 'failed';
        setCommandHistory(prev => {
          const updated = [...prev];
          updated[historyIndex] = newHistory;
          return updated;
        });
      }

    } catch (error) {
      console.error('Command execution error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Command failed';
      newHistory.output = [...newHistory.output, `Error: ${errorMessage}`];
      newHistory.status = 'failed';
      setCommandHistory(prev => {
        const updated = [...prev];
        updated[historyIndex] = newHistory;
        return updated;
      });
    } finally {
      setIsExecuting(false);
      setCurrentPid(null);
      if (streamControlRef.current) {
        streamControlRef.current.close();
        streamControlRef.current = null;
      }
    }
  };

  // Handle command history navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isExecuting) {
      executeCommand(currentCommand);
      setHistoryIndex(-1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const commands = commandHistory.filter(h => h.command);
      if (commands.length > 0) {
        const newIndex = historyIndex === -1 ? commands.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setCurrentCommand(commands[newIndex]?.command || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const commands = commandHistory.filter(h => h.command);
      if (historyIndex !== -1) {
        const newIndex = historyIndex + 1;
        if (newIndex >= commands.length) {
          setHistoryIndex(-1);
          setCurrentCommand('');
        } else {
          setHistoryIndex(newIndex);
          setCurrentCommand(commands[newIndex]?.command || '');
        }
      }
    }
  };

  // Get prompt style based on status
  const getPromptStyle = () => {
    const time = getTimeString();
    const dir = workingDir.split('/').pop() || 'app';
    const arrow = '❯';

    return (
      <span className="flex items-center gap-2">
        <span style={{ color: '#f1fa8c' }}>[{time}]</span>
        <span style={{ color: '#50fa7b' }}>sandbox</span>
        <span style={{ color: '#8be9fd' }}>@</span>
        <span style={{ color: '#ff79c6' }}>{dir}</span>
        <span style={{ color: isExecuting ? '#ffb86c' : '#50fa7b' }}>{arrow}</span>
      </span>
    );
  };

  if (!sandboxInstance) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: '#282a36', color: '#f8f8f2' }}>
        <p>Sandbox not available</p>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col p-4 font-mono text-sm"
      style={{
        background: '#282a36',
        color: '#f8f8f2'
      }}
      onClick={() => inputRef.current?.focus()}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between mb-4 pb-2 border-b" style={{ borderColor: '#44475a' }}>
        <div className="flex items-center gap-3">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full" style={{ background: '#ff5555' }}></div>
            <div className="w-3 h-3 rounded-full" style={{ background: '#ffb86c' }}></div>
            <div className="w-3 h-3 rounded-full" style={{ background: '#50fa7b' }}></div>
          </div>
          <span style={{ color: '#bd93f9' }}>Terminal</span>
        </div>
        <div className="flex items-center gap-2 text-xs" style={{ color: '#6272a4' }}>
          <span>bash</span>
          <span>•</span>
          <span>{workingDir}</span>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 overflow-auto">
        {/* Command History */}
        {commandHistory.map((entry, index) => (
          <div key={index} className="mb-4">
            <div className="flex items-start gap-2">
              {getPromptStyle()}
              <span style={{ color: '#f8f8f2' }}>{entry.command}</span>
            </div>
            {entry.output.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className="ml-2 whitespace-pre-wrap"
                style={{
                  color: entry.status === 'failed' ? '#ff5555' : '#f8f8f2',
                  opacity: 0.9
                }}
              >
                {line}
              </div>
            ))}
          </div>
        ))}

                {/* Current Input Line */}
        <div className="flex items-start gap-2">
          {getPromptStyle()}
          <input
            ref={inputRef}
            type="text"
            value={currentCommand}
            onChange={(e) => !isExecuting && setCurrentCommand(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none"
            style={{ color: '#f8f8f2', opacity: isExecuting ? 0.5 : 1 }}
            placeholder={isExecuting ? 'Executing... (Ctrl+C to stop)' : 'Type a command...'}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div ref={terminalEndRef} />
      </div>

      {/* Terminal Footer */}
      <div className="mt-4 pt-2 border-t flex items-center justify-between text-xs" style={{ borderColor: '#44475a', color: '#6272a4' }}>
        <div className="flex items-center gap-4">
          <span>Use ↑↓ for history</span>
          <span>Ctrl+C to stop</span>
          <span>Type 'clear' to clear</span>
        </div>
        {isExecuting && currentPid && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#50fa7b' }}></div>
            <span>PID: {currentPid}</span>
          </div>
        )}
      </div>
    </div>
  );
}
