'use client';

import { useChat } from '@ai-sdk/react';
import { SandboxInstance } from '@blaxel/core';
export function Chatbot({ sandbox, className }: { sandbox: SandboxInstance, className?: string }) {
  const { messages, input, handleInputChange, handleSubmit, status, error } = useChat({
    api: '/api/chat',
    maxSteps: 25, // Enable multi-step tool calling
    // Handle client-side tool calling
    async onToolCall({ toolCall }) {
      const tool = sandbox.fs.tools[toolCall.toolName as keyof typeof sandbox.fs.tools]
      if (tool) {
        try {
          // Optionally: log the tool call for debugging
          console.log('Tool call:', toolCall);
          // @ts-expect-error just let it be
          const result = await tool.execute(toolCall.args)
          // Optionally: log the result
          console.log('Tool result:', result);
          return result
        } catch (err) {
          console.error('Tool execution error:', err);
          // Return a structured error message
          return { error: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      } else {
        const msg = `Tool not found: ${toolCall.toolName}`;
        console.error(msg);
        return { error: msg };
      }
    }
  });

  return (
    <div
      className={`flex flex-col rounded-lg shadow-sm h-full ${className || ''}`}
      style={{ background: 'var(--secondary)', border: '1px solid var(--border)', color: 'var(--secondary-foreground)' }}
    >
      <div
        className="px-4 py-2 rounded-t-lg flex justify-between items-center"
        style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
      >
        <h3 className="text-sm font-medium">App Assistant</h3>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-4">
        {messages.map(message => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2`}
              style={
                message.role === 'user'
                  ? { background: 'var(--primary)', color: 'var(--primary-foreground)' }
                  : { background: 'var(--muted)', color: 'var(--foreground)' }
              }
            >
              {/* Render message content */}
              {message.parts.map((part, index) => {
                switch (part.type) {
                  case 'text':
                    return (
                      <div
                        key={index}
                        style={{
                          marginBottom: 4,
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'transparent'
                        }}
                      >
                        {part.text}
                      </div>
                    );
                  case 'tool-invocation':
                    return (
                      <div
                        key={index}
                        style={{
                          marginBottom: 4,
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: '#fffbe6',
                          color: '#ad8b00',
                          borderLeft: '4px solid #ffe58f',
                          display: 'flex',
                          alignItems: 'center',
                          fontFamily: 'monospace'
                        }}
                      >
                        <span style={{ marginRight: 8 }}>🛠️</span>
                        <span>Tool: <b>{part.toolInvocation.toolName}</b></span>
                      </div>
                    );
                  case 'reasoning':
                    return (
                      <div
                        key={index}
                        style={{
                          marginBottom: 4,
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: '#f6ffed',
                          color: '#389e0d',
                          borderLeft: '4px solid #b7eb8f',
                          display: 'flex',
                          alignItems: 'center'
                        }}
                      >
                        <span style={{ marginRight: 8 }}>💡</span>
                        <span>{part.reasoning}</span>
                      </div>
                    );
                  default:
                    return null;
                }
              })}
            </div>
          </div>
        ))}

        {status === 'submitted' && (
          <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2 max-w-[80%]" style={{ background: 'var(--muted)' }}>
              <div className="flex space-x-2">
                <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'var(--muted-foreground)', animationDelay: '0ms' }}></div>
                <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'var(--muted-foreground)', animationDelay: '150ms' }}></div>
                <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'var(--muted-foreground)', animationDelay: '300ms' }}></div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="px-3 py-2 rounded text-sm" style={{ background: 'var(--error)', color: 'var(--primary-foreground)', border: '1px solid var(--border)' }}>
            Error: {error.toString()}
          </div>
        )}
      </div>

      <div className="p-3" style={{ borderTop: '1px solid var(--border)' }}>
        <form onSubmit={handleSubmit} className="flex">
          <input
            type="text"
            value={input}
            onChange={handleInputChange}
            placeholder="Type your message..."
            className="flex-grow px-3 py-2 rounded-l-md focus:outline-none focus:ring-2"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            disabled={status === 'submitted'}
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-r-md cursor-pointer"
            style={
              status === 'submitted'
                ? { background: 'var(--muted)', color: 'var(--muted-foreground)', cursor: 'not-allowed', opacity: 0.6 }
                : { background: 'var(--primary)', color: 'var(--primary-foreground)' }
            }
            disabled={status === 'submitted'}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}