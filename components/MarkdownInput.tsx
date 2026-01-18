import React, { useRef, useState, useEffect } from 'react';
import { FileText, Upload, X, Command } from 'lucide-react';
import { GenerationMode } from '../services/geminiService';

interface MarkdownInputProps {
  value: string;
  onChange: (value: string) => void;
  isGenerating: boolean;
  onGenerate: () => void;
  mode: GenerationMode;
}

const MarkdownInput: React.FC<MarkdownInputProps> = ({ value, onChange, isGenerating, onGenerate, mode }) => {
  const [activeTab, setActiveTab] = useState<'write' | 'upload'>('write');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result;
      if (typeof content === 'string') {
        onChange(content);
        setActiveTab('write');
      }
    };
    reader.readAsText(file);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      onGenerate();
    }
  };

  const getAccentClass = () => {
    switch(mode) {
      case 'presentation': return 'text-blue-500 focus:ring-blue-500/20';
      case 'visual-asset': return 'text-amber-500 focus:ring-amber-500/20';
      case 'vector-svg': return 'text-purple-500 focus:ring-purple-500/20';
      case 'sticker': return 'text-pink-500 focus:ring-pink-500/20';
      default: return 'text-emerald-500 focus:ring-emerald-500/20';
    }
  };

  const getBorderClass = () => {
     switch(mode) {
      case 'presentation': return 'group-focus-within:border-blue-500/50';
      case 'visual-asset': return 'group-focus-within:border-amber-500/50';
      case 'vector-svg': return 'group-focus-within:border-purple-500/50';
      case 'sticker': return 'group-focus-within:border-pink-500/50';
      default: return 'group-focus-within:border-emerald-500/50';
    }
  };

  return (
    <div className={`flex flex-col h-full bg-[#12141c] border border-white/5 rounded-[2.5rem] overflow-hidden shadow-2xl transition-colors duration-300 group ${getBorderClass()}`}>
      <div className="p-8 border-b border-white/5 flex flex-col h-full">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">Project Source</h2>
          <div className="flex bg-black/40 p-1 rounded-xl">
            <button onClick={() => setActiveTab('write')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === 'write' ? 'bg-[#1e222d] text-white shadow-lg' : 'text-slate-500'}`}>Write</button>
            <button onClick={() => setActiveTab('upload')} className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${activeTab === 'upload' ? 'bg-[#1e222d] text-white shadow-lg' : 'text-slate-500'}`}>Import</button>
          </div>
        </div>

        {activeTab === 'upload' ? (
           <div className="h-full min-h-[440px] border-2 border-dashed border-white/5 rounded-3xl flex flex-col items-center justify-center gap-6 hover:bg-white/[0.02] transition-all cursor-pointer" onClick={() => fileInputRef.current?.click()}>
             <div className={`p-6 bg-white/5 rounded-full border border-white/10 ${getAccentClass().split(' ')[0]}`}>
               <Upload className="w-10 h-10 opacity-50" />
             </div>
             <p className="text-slate-400 text-sm font-medium">Drop markdown files here</p>
             <input ref={fileInputRef} type="file" accept=".md,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
           </div>
        ) : (
          <div className="relative flex-1">
             <textarea
              disabled={isGenerating}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="# Markdown Source Code..."
              className={`w-full h-full min-h-[440px] bg-black/30 text-slate-300 p-6 rounded-3xl resize-none focus:outline-none focus:ring-2 font-mono text-[13px] leading-relaxed tracking-tight border border-white/5 transition-all ${getAccentClass()}`}
              spellCheck={false}
            />
            {value && (
               <button onClick={() => onChange('')} className="absolute top-6 right-6 p-2 text-slate-500 hover:text-white bg-black/40 rounded-xl transition-all z-10">
                 <X className="w-4 h-4" />
               </button>
            )}
            
            <div className="absolute bottom-6 right-6 pointer-events-none">
              <span className="flex items-center gap-1.5 text-[10px] font-bold text-slate-600 bg-black/60 px-2 py-1 rounded-md border border-white/5">
                <Command className="w-3 h-3" />
                RETURN
              </span>
            </div>
          </div>
        )}
      </div>
      
      <div className="px-8 py-5 bg-black/20 flex items-center justify-between">
        <p className="text-[11px] font-bold text-slate-600 uppercase tracking-widest flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${mode === 'infographic' ? 'bg-emerald-500' : mode === 'presentation' ? 'bg-blue-500' : mode === 'visual-asset' ? 'bg-amber-500' : mode === 'vector-svg' ? 'bg-purple-500' : 'bg-pink-500'}`} />
          Syntax Ready
        </p>
        <FileText className="w-4 h-4 text-slate-700" />
      </div>
    </div>
  );
};

export default MarkdownInput;