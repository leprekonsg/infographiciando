import React from 'react';
import { BarChart3, Bot, Zap, Settings } from 'lucide-react';

interface HeaderProps {
  view: 'quick' | 'agentic';
  setView: (view: 'quick' | 'agentic') => void;
}

const Header: React.FC<HeaderProps> = ({ view, setView }) => {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-[#0a0c10]/80 backdrop-blur-xl sticky top-0 z-50 h-[80px]">
      <div className="flex items-center gap-3 w-[200px]">
        <div className="bg-emerald-500/10 p-2 rounded-xl border border-emerald-500/20">
           <BarChart3 className="w-5 h-5 text-emerald-500" />
        </div>
        <span className="text-xl font-black text-white tracking-tighter">InfographIQ.</span>
      </div>

      <div className="bg-[#12141c] border border-white/5 p-1 rounded-xl flex items-center gap-1 shadow-inner">
         <button 
           onClick={() => setView('agentic')} 
           className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${view === 'agentic' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' : 'text-slate-500 hover:text-white hover:bg-white/5'}`}
         >
           <Bot className="w-4 h-4" /> Agentic Builder
         </button>
         <button 
           onClick={() => setView('quick')} 
           className={`px-6 py-2.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${view === 'quick' ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-900/20' : 'text-slate-500 hover:text-white hover:bg-white/5'}`}
         >
           <Zap className="w-4 h-4" /> Quick Generate
         </button>
      </div>

      <div className="flex items-center justify-end gap-4 w-[200px]">
        <button className="p-2 text-slate-500 hover:text-white transition-colors">
            <Settings className="w-5 h-5" />
        </button>
        <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-emerald-500 to-blue-500 shadow-inner border border-white/10" />
      </div>
    </header>
  );
};

export default Header;