
import React, { useEffect, useRef } from 'react';
import { Bot, CheckCircle2, AlertTriangle, Terminal, ShieldCheck, Milestone } from 'lucide-react';

export interface ActivityLogItem {
  id: string;
  message: string;
  timestamp: Date;
  type: 'info' | 'success' | 'agent' | 'error' | 'validation';
  agentName?: string;
}

interface ActivityFeedProps {
  logs: ActivityLogItem[];
  progress: number;
}

const ActivityFeed: React.FC<ActivityFeedProps> = ({ logs, progress }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="bg-[#12141c] rounded-[2.5rem] border border-white/5 p-8 flex flex-col h-full min-h-[500px] shadow-2xl relative overflow-hidden">
        <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
            <Bot className="w-5 h-5 text-blue-500" /> Agent Neural Net
        </h3>
        
        <div className="mb-8">
            <div className="flex justify-between text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
            <span>GENERATION PROGRESS</span>
            <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-blue-600 to-emerald-400 transition-all duration-500 ease-out" style={{ width: `${progress}%` }}></div>
            </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar" ref={scrollRef}>
            {logs.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-4 opacity-50">
                <Terminal className="w-12 h-12" />
                <p className="text-sm font-medium">System Idle</p>
            </div>
            )}
            {logs.map((log) => (
            <div key={log.id} className="flex gap-3 animate-reveal">
                <div className={`mt-0.5 w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 
                    ${log.type === 'agent' ? 'bg-blue-500/10 text-blue-500' : 
                      log.type === 'success' ? 'bg-emerald-500/10 text-emerald-500' : 
                      log.type === 'validation' ? 'bg-amber-500/10 text-amber-500' :
                      log.type === 'error' ? 'bg-red-500/10 text-red-500' : 'bg-slate-700/50 text-slate-400'}`}>
                    {log.type === 'agent' ? <Bot className="w-3 h-3" /> : 
                     log.type === 'success' ? <CheckCircle2 className="w-3 h-3" /> : 
                     log.type === 'validation' ? <ShieldCheck className="w-3 h-3" /> :
                     log.type === 'error' ? <AlertTriangle className="w-3 h-3" /> : <Terminal className="w-3 h-3" />}
                </div>
                <div className="flex-1 min-w-0">
                    {log.agentName && <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">{log.agentName}</p>}
                    <p className="text-sm text-slate-300 leading-snug">{log.message}</p>
                    <span className="text-[10px] text-slate-600 font-mono mt-1 block">{log.timestamp.toLocaleTimeString()}</span>
                </div>
            </div>
            ))}
        </div>
    </div>
  );
};

export default ActivityFeed;
