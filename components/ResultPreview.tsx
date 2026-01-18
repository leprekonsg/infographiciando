import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Download, Wand2, Box, Image as ImageIcon, AlertTriangle, Sparkles } from 'lucide-react';
import { GeneratedImageResult, GenerationMode } from '../services/geminiService';

interface ResultPreviewProps {
  onGenerate: () => void;
  isGenerating: boolean;
  results: GeneratedImageResult[];
  statusMessage?: string;
  mode: GenerationMode;
  error?: string | null;
}

const ResultPreview: React.FC<ResultPreviewProps> = ({ onGenerate, isGenerating, results, statusMessage, mode, error }) => {
  const [currentIndex, setCurrentIndex] = useState(0);

  // UX Fix: Reset or adjust index when the mode changes or results array changes
  useEffect(() => {
    if (results.length > 0) {
        // If we switched modes and the index is out of bounds, or if we just generated new content
        setCurrentIndex(results.length - 1);
    } else {
        setCurrentIndex(0);
    }
  }, [results.length, mode]); // Depend on mode to trigger reset when tab changes

  const safeIndex = Math.min(currentIndex, Math.max(0, results.length - 1));
  const currentResult = results[safeIndex];

  const downloadImage = (dataUrl: string, filename: string) => {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getAccentColor = () => {
    if (mode === 'presentation') return 'bg-blue-600';
    if (mode === 'visual-asset') return 'bg-amber-500';
    if (mode === 'vector-svg') return 'bg-purple-600';
    if (mode === 'sticker') return 'bg-pink-500';
    return 'bg-emerald-500';
  };

  const getAccentText = () => {
    if (mode === 'presentation') return 'text-blue-400';
    if (mode === 'visual-asset') return 'text-amber-400';
    if (mode === 'vector-svg') return 'text-purple-400';
    if (mode === 'sticker') return 'text-pink-400';
    return 'text-emerald-400';
  };

  const isSquare = mode === 'visual-asset' || mode === 'vector-svg' || mode === 'sticker';

  // UX: Dynamic empty state message
  const getEmptyMessage = () => {
     if (mode === 'presentation') return "No slides generated yet. Try 'Cloud Architecture'.";
     if (mode === 'visual-asset') return "No 3D assets found. Describe a concept.";
     if (mode === 'vector-svg') return "No icons created. Need a symbol?";
     if (mode === 'sticker') return "No stickers printed. Create a badge.";
     return "System Idle. Generate your first infographic.";
  };

  return (
    <div className="flex flex-col h-full bg-[#12141c] border border-white/5 rounded-[2.5rem] overflow-hidden shadow-2xl transition-colors duration-300">
      <div className="p-8 flex flex-col h-full">
        <div className="flex items-center justify-between mb-8">
           <h2 className="text-xl font-bold text-white">Visual Preview</h2>
           {results.length > 0 && (
             <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600 bg-white/5 px-3 py-1 rounded-full border border-white/5">
               {mode} History: {results.length}
             </span>
           )}
        </div>

        <div className="flex-1 flex flex-col items-center justify-center relative bg-black/20 rounded-[2rem] border border-white/[0.02] overflow-hidden min-h-[400px]">
          
          {error && (
            <div className="absolute inset-0 z-10 bg-[#12141c]/95 flex flex-col items-center justify-center p-8 text-center animate-reveal">
               <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mb-4 border border-red-500/20">
                 <AlertTriangle className="w-8 h-8 text-red-500" />
               </div>
               <h3 className="text-lg font-bold text-white mb-2">Generation Failed</h3>
               <p className="text-slate-400 text-sm max-w-xs">{error}</p>
               <button onClick={onGenerate} className="mt-6 px-6 py-2 bg-white/5 hover:bg-white/10 text-white text-xs font-bold uppercase tracking-wider rounded-xl transition-all">
                 Retry
               </button>
            </div>
          )}

          {!results.length && !isGenerating && !error && (
            <div className="text-center space-y-6 opacity-40 animate-reveal">
              <div className="w-24 h-24 bg-white/[0.02] rounded-3xl flex items-center justify-center mx-auto border border-white/5">
                <Box className="w-10 h-10 text-slate-500" />
              </div>
              <p className="text-slate-500 font-bold text-sm tracking-tight">{getEmptyMessage()}</p>
            </div>
          )}

          {isGenerating && (
            <div className="absolute inset-0 z-20 bg-[#12141c]/90 backdrop-blur-sm flex flex-col items-center justify-center space-y-8 animate-reveal">
              <div className="relative w-20 h-20 mx-auto">
                 <div className="absolute inset-0 border-[3px] border-white/5 rounded-full"></div>
                 <div className={`absolute inset-0 border-[3px] ${getAccentText()} rounded-full border-t-transparent animate-spin`}></div>
              </div>
              <div className="space-y-1 text-center">
                <p className="text-white font-bold tracking-tight">Intelligence Active</p>
                <p className="text-slate-500 text-xs font-medium animate-pulse">{statusMessage}</p>
              </div>
            </div>
          )}

          {results.length > 0 && currentResult && !error && (
            <div className="w-full h-full flex flex-col items-center justify-center p-8 animate-reveal">
               
               <div className={`relative group w-full ${isSquare ? 'max-w-[320px] aspect-square' : mode === 'presentation' ? 'max-w-xl aspect-video' : 'max-w-[340px] aspect-[3/4]'} ${mode === 'vector-svg' || mode === 'sticker' ? 'bg-[#1a1d26] bg-[url("https://www.transparenttextures.com/patterns/cubes.png")]' : 'bg-white'} rounded-2xl overflow-hidden shadow-2xl ring-1 ring-white/10`}>
                 <img src={currentResult.imageUrl} className="w-full h-full object-contain" alt="Generation" />
                 
                 <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center backdrop-blur-sm">
                    <button onClick={() => downloadImage(currentResult.imageUrl, `${mode}-${safeIndex + 1}.${mode === 'vector-svg' ? 'svg' : 'png'}`)} className={`flex items-center gap-3 px-8 py-4 ${getAccentColor()} text-black font-black rounded-2xl hover:scale-105 transition-transform shadow-2xl`}>
                      <Download className="w-5 h-5" />
                      Export {mode === 'vector-svg' ? 'SVG' : 'PNG'}
                    </button>
                 </div>
               </div>
               
               <p className="mt-8 text-white font-black text-xl tracking-tighter text-center max-w-md mx-auto">{currentResult.sectionTitle}</p>
            </div>
          )}
        </div>

        <div className="mt-10 pt-8 border-t border-white/5 space-y-8">
          {!results.length && !isGenerating ? (
            <button onClick={onGenerate} className={`w-full py-5 rounded-2xl font-black text-white text-lg shadow-2xl flex items-center justify-center gap-3 transition-all ${getAccentColor()} text-black hover:scale-[1.02] active:scale-95`}>
              <Wand2 className="w-5 h-5" />
              Generate {mode === 'infographic' ? 'Infographic' : mode === 'presentation' ? 'Slides' : mode === 'visual-asset' ? 'Assets' : mode === 'vector-svg' ? 'Icons' : 'Stickers'}
            </button>
          ) : (
             <div className="flex flex-col gap-6">
               <div className="flex items-center justify-between">
                  <button onClick={() => setCurrentIndex(p => p - 1)} disabled={safeIndex === 0} className="p-4 rounded-xl border border-white/5 text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-10 transition-all">
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <div className="flex flex-col items-center">
                    <span className="text-white font-black text-sm">{safeIndex + 1} / {results.length}</span>
                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">Instance</span>
                  </div>
                  <button onClick={() => setCurrentIndex(p => p + 1)} disabled={safeIndex === results.length - 1} className="p-4 rounded-xl border border-white/5 text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-10 transition-all">
                    <ChevronRight className="w-6 h-6" />
                  </button>
               </div>
               
               <button onClick={onGenerate} disabled={isGenerating} className="w-full py-4 rounded-2xl text-xs font-black uppercase tracking-[0.2em] text-slate-500 hover:text-white hover:bg-white/5 border border-white/5 transition-all flex items-center justify-center gap-2 group">
                <Sparkles className={`w-4 h-4 transition-colors ${getAccentText()}`} />
                {isGenerating ? statusMessage : 'Generate Another Variant'}
               </button>
             </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ResultPreview;