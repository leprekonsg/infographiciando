
import React, { useRef, useEffect, useState } from 'react';
import { SlideNode, GlobalStyleGuide } from '../types/slideTypes';
import { InfographicRenderer } from '../services/infographicRenderer';
import { RefreshCw, Shuffle, Image as ImageIcon, Cpu } from 'lucide-react';

interface BuilderCanvasProps {
    slide: SlideNode;
    styleGuide: GlobalStyleGuide;
    onRegenerateVisual: () => void;
    isRegeneratingVisual: boolean;
}

const BuilderCanvas: React.FC<BuilderCanvasProps> = ({ slide, styleGuide, onRegenerateVisual, isRegeneratingVisual }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1);
    const BASE_WIDTH = 960;
    const BASE_HEIGHT = 540;

    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            const scaleX = width / BASE_WIDTH;
            const scaleY = height / BASE_HEIGHT;
            setScale(Math.min(scaleX, scaleY) * 0.95);
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [slide]);

    const renderCanvas = () => {
        const renderer = new InfographicRenderer();
        const elements = renderer.compileSlide(slide, styleGuide);
        const bgHex = (styleGuide?.colorPalette?.background || "#0f172a").replace('#','');

        const toPxX = (val: number) => (val / 10) * BASE_WIDTH;
        const toPxY = (val: number) => (val / 5.625) * BASE_HEIGHT;
        const toPxFont = (pt: number) => Math.max(8, pt * 1.33);

        return (
            <div className="relative shadow-2xl overflow-hidden group"
                 style={{ width: BASE_WIDTH, height: BASE_HEIGHT, backgroundColor: `#${bgHex}` }}>
                
                {/* Background */}
                <div className="absolute inset-0 bg-cover bg-center opacity-40 transition-all duration-500" 
                     style={{ backgroundImage: slide.backgroundImageUrl ? `url(${slide.backgroundImageUrl})` : 'none' }} />

                {/* Elements */}
                {elements.map((el, i) => {
                    if (el.type === 'shape') {
                        return (
                            <div key={i} className="absolute flex items-center justify-center text-center transition-all"
                                style={{
                                    left: toPxX(el.x), top: toPxY(el.y),
                                    width: toPxX(el.w), height: toPxY(el.h),
                                    backgroundColor: el.fill ? `#${el.fill.color}` : 'transparent',
                                    opacity: el.fill ? el.fill.alpha : 1,
                                    border: el.border ? `${el.border.width}px solid #${el.border.color}` : 'none',
                                    borderRadius: el.shapeType === 'roundRect' ? '8px' : el.shapeType === 'ellipse' ? '50%' : '0px',
                                    transform: el.rotation ? `rotate(${el.rotation}deg)` : 'none',
                                    color: el.textColor ? `#${el.textColor}` : 'inherit',
                                    zIndex: el.zIndex
                                }}>
                                {el.text}
                            </div>
                        );
                    } else if (el.type === 'text') {
                        return (
                            <div key={i} className="absolute transition-all"
                                style={{
                                    left: toPxX(el.x), top: toPxY(el.y),
                                    width: toPxX(el.w), height: toPxY(el.h),
                                    fontSize: `${toPxFont(el.fontSize)}px`,
                                    color: `#${el.color}`,
                                    fontFamily: el.fontFamily,
                                    fontWeight: el.bold ? 'bold' : 'normal',
                                    fontStyle: el.italic ? 'italic' : 'normal',
                                    textAlign: el.align || 'left',
                                    transform: el.rotation ? `rotate(${el.rotation}deg)` : 'none',
                                    zIndex: el.zIndex
                                }}>
                                {el.content}
                            </div>
                        );
                    }
                    return null;
                })}

                {/* Fallback for Standard Layouts (if not using AgentLayout) */}
                {!slide.agentLayout && slide.layoutPlan && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                         <div className="bg-black/50 text-white p-4 rounded-xl backdrop-blur-md">
                            Previewing Standard Component Layout
                         </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="bg-[#12141c] rounded-3xl border border-white/5 p-6 flex flex-col h-full">
            <div className="flex items-center justify-between mb-4">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase">
                    <ImageIcon className="w-3 h-3" /> Visual Preview
                </label>
                <button onClick={onRegenerateVisual} disabled={isRegeneratingVisual} 
                    className="text-[10px] bg-white/5 px-2 py-1 rounded hover:bg-white/10 text-slate-400 flex items-center gap-1">
                    <RefreshCw className={`w-3 h-3 ${isRegeneratingVisual ? 'animate-spin' : ''}`} /> Remix Visual
                </button>
            </div>
            <div ref={containerRef} className="flex-1 w-full min-h-0 flex items-center justify-center overflow-hidden bg-[#0c0e14] relative rounded-xl border border-white/10">
                <div style={{ width: BASE_WIDTH, height: BASE_HEIGHT, transform: `scale(${scale})`, transformOrigin: 'center center' }}>
                    {renderCanvas()}
                </div>
            </div>
        </div>
    );
};

export default BuilderCanvas;
