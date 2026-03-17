import { useState, useRef, useEffect } from 'react'

function ToolCallBlock({ toolCall }) {
  const [expanded, setExpanded] = useState(false)
  const isError = toolCall.status === 'error'

  return (
    <div className="bg-gray-100 border border-gray-200 rounded p-2 mb-2 font-mono text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold">{toolCall.name}</span>
          <span className={`px-1.5 py-0.5 rounded text-white text-[10px] ${isError ? 'bg-red-500' : 'bg-green-600'}`}>
            {toolCall.status}
          </span>
        </div>
        <button
          className="text-gray-500 hover:text-gray-700 text-xs cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1">
          <div>
            <span className="text-gray-500">Args: </span>
            <pre className="inline whitespace-pre-wrap break-all">{JSON.stringify(toolCall.args, null, 2)}</pre>
          </div>
          <div>
            <span className="text-gray-500">Result: </span>
            <pre className="inline whitespace-pre-wrap break-all max-h-40 overflow-auto block">
              {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end mb-3">
        <div className="bg-blue-600 text-white rounded-lg px-4 py-2 max-w-[70%] whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start mb-3">
      <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 max-w-[70%]">
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2">
            {message.toolCalls.map((tc, i) => (
              <ToolCallBlock key={i} toolCall={tc} />
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap">{message.content}</div>
      </div>
    </div>
  )
}

export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!loading) {
      textareaRef.current?.focus()
    }
  }, [loading])

  function newSession() {
    setMessages([])
    setSessionId(null)
    setInput('')
  }

  async function sendMessage(e) {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text }),
      })

      const data = await res.json()

      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${data.error || 'Unknown error'}`, toolCalls: [] }])
        return
      }

      if (data.sessionId) setSessionId(data.sessionId)

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.response,
        toolCalls: data.toolCalls || [],
      }])
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Network error: ${err.message}`, toolCalls: [] }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(e)
    }
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white">
        <h1 className="text-lg font-bold">Jarvis</h1>
        <button
          onClick={newSession}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-100 cursor-pointer"
        >
          New Session
        </button>
      </header>

      {/* Message area */}
      <main className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            Send a message to start a conversation.
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {loading && (
          <div className="flex justify-start mb-3">
            <div className="bg-white border border-gray-200 rounded-lg px-4 py-2 text-gray-400 text-sm">
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* Input area */}
      <form onSubmit={sendMessage} className="border-t border-gray-200 bg-white px-6 py-3 flex gap-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
          placeholder="Type a message..."
          rows={1}
          className="flex-1 resize-none border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          Send
        </button>
      </form>
    </div>
  )
}
