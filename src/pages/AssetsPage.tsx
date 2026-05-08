import { motion } from 'framer-motion';
import { 
  FileBox, 
  Presentation, 
  FileText, 
  Download, 
  Loader2, 
  Sparkles,
  File as FileIcon
} from 'lucide-react';
import { TaskHistory, GeneratedAsset } from '../services/awsService';
import { AssetsPageSkeleton } from '../components/Skeleton';

interface AssetsPageProps {
  selectedTask: TaskHistory | null;
  slideCount: number;
  setSlideCount: (count: number) => void;
  isGeneratingAsset: boolean;
  handleGeneratePPT: () => void;
  handleGenerateReport: () => void;
  selectedAsset: GeneratedAsset | null;
  setSelectedAsset: (asset: GeneratedAsset | null) => void;
  assetHistory: GeneratedAsset[];
  downloadExistingAsset: (asset: GeneratedAsset) => void;
  isLoading?: boolean;
}

export default function AssetsPage({
  selectedTask,
  slideCount,
  setSlideCount,
  isGeneratingAsset,
  handleGeneratePPT,
  handleGenerateReport,
  selectedAsset,
  setSelectedAsset,
  assetHistory,
  downloadExistingAsset,
  isLoading = false,
}: AssetsPageProps) {
  // Show skeleton while loading
  if (isLoading || !selectedTask) {
    return <AssetsPageSkeleton />;
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-app-panel text-app-fg overflow-hidden">
      {/* Fixed Header */}
      <div className="flex-none bg-white border-b border-[#141414]/10 px-4 sm:px-8 pt-6 pb-4">
        <div className="max-w-5xl mx-auto">
          {/* Breadcrumb */}
          <div className="flex items-center gap-4 mb-4 opacity-50 text-sm overflow-x-auto no-scrollbar whitespace-nowrap">
            <FileBox className="w-4 h-4 flex-shrink-0" />
            <span>Library</span>
            <span>/</span>
            <span className="truncate">{selectedTask.filename}</span>
            <span>/</span>
            <span>Assets</span>
          </div>

          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Content Assets</h1>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-12">
            <div className="lg:col-span-2 space-y-8">
              {/* Generation Options */}
              <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 bg-orange-100 text-orange-600 rounded-xl">
                      <Presentation className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold">Presentation</h3>
                      <p className="text-[10px] opacity-50 uppercase font-mono">PPTX Format</p>
                    </div>
                  </div>
                  
                  <div className="flex-1 space-y-4 mb-8">
                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] font-mono uppercase opacity-50">Slide Count</label>
                      <input 
                        type="number" 
                        min="3" 
                        max="20" 
                        value={isNaN(slideCount) ? '' : slideCount}
                        onChange={(e) => {
                          const val = parseInt(e.target.value);
                          setSlideCount(isNaN(val) ? 0 : val);
                        }}
                        className="border border-[#141414] p-2 text-sm font-mono"
                      />
                    </div>
                    <p className="text-xs opacity-60">Generate a professional slide deck based on the transcription content.</p>
                  </div>

                  <button 
                    onClick={handleGeneratePPT}
                    disabled={isGeneratingAsset}
                    className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                  >
                    {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    Generate PPT
                  </button>
                </div>

                <div className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-3 bg-blue-100 text-blue-600 rounded-xl">
                      <FileText className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold">Formal Report</h3>
                      <p className="text-[10px] opacity-50 uppercase font-mono">DOCX Format</p>
                    </div>
                  </div>
                  
                  <div className="flex-1 mb-8">
                    <p className="text-xs opacity-60">Create a structured, professional document with executive summary and detailed sections.</p>
                  </div>

                  <button 
                    onClick={handleGenerateReport}
                    disabled={isGeneratingAsset}
                    className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                  >
                    {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    Generate DOCX
                  </button>
                </div>
              </section>

              {/* Preview Area */}
              <section className="border border-[#141414] bg-[#F5F5F5] p-4 sm:p-8 rounded-2xl min-h-[400px] flex flex-col">
                {!selectedAsset ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-center">
                    <Sparkles className="w-12 h-12 mb-4 opacity-10" />
                    <h3 className="text-lg font-serif italic opacity-30">Asset Preview</h3>
                    <p className="text-xs opacity-30 mt-2">Generate or select an asset to see its structure here</p>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto">
                    <div className="flex items-center justify-between mb-6 border-b border-[#141414]/10 pb-4">
                      <div className="flex items-center gap-3">
                        {selectedAsset.type === 'ppt' ? <Presentation className="w-5 h-5 text-orange-600" /> : <FileText className="w-5 h-5 text-blue-600" />}
                        <h3 className="font-bold text-sm">{selectedAsset.filename}</h3>
                      </div>
                      <button 
                        onClick={() => downloadExistingAsset(selectedAsset)}
                        className="flex items-center gap-2 px-3 py-1.5 bg-[#141414] text-white text-[10px] font-mono uppercase tracking-widest hover:bg-[#333] transition-all"
                      >
                        <Download className="w-3 h-3" />
                        Download
                      </button>
                    </div>

                    <div className="bg-white p-6 sm:p-8 border border-[#141414]/5 shadow-sm rounded-xl">
                      {selectedAsset.type === 'ppt' ? (
                        selectedAsset.content.slides ? (
                          // Old format: JSON structure with slides array
                          <div className="space-y-8">
                            <div className="text-center py-12 border-b border-[#141414]/5">
                              <h2 className="text-3xl font-bold tracking-tight mb-2">{selectedAsset.content.title}</h2>
                              <p className="text-xs font-mono opacity-40 uppercase tracking-widest">Title Slide</p>
                            </div>
                            {selectedAsset.content.slides.map((slide: any, idx: number) => (
                              <div key={idx} className="space-y-4">
                                <div className="flex items-center gap-4">
                                  <span className="text-[10px] font-mono opacity-30 uppercase">Slide {idx + 1}</span>
                                  <h4 className="font-bold text-lg">{slide.title}</h4>
                                </div>
                                <ul className="space-y-2 pl-4 border-l-2 border-[#141414]/5">
                                  {slide.content.map((bullet: string, bidx: number) => (
                                    <li key={bidx} className="text-sm opacity-70 flex items-start gap-2">
                                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#141414]/20 flex-shrink-0" />
                                      {bullet}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        ) : (
                          // New E2B format: no preview available
                          <div className="text-center py-24 space-y-4">
                            <Presentation className="w-16 h-16 mx-auto opacity-20" />
                            <div>
                              <h3 className="text-lg font-semibold mb-2">E2B-Generated Presentation</h3>
                              <p className="text-sm opacity-60 max-w-md mx-auto">
                                This presentation was generated using E2B sandbox execution. 
                                {selectedAsset.content.slideCount && ` Contains ${selectedAsset.content.slideCount} slides.`}
                              </p>
                              <p className="text-xs opacity-40 mt-4">
                                Preview not available. Click "Download" above to view the presentation.
                              </p>
                            </div>
                          </div>
                        )
                      ) : (
                        <div className="space-y-8">
                          <div className="border-b border-[#141414]/5 pb-6">
                            <h2 className="text-3xl font-bold tracking-tight">{selectedAsset.content?.title || selectedAsset.filename}</h2>
                          </div>
                          {(selectedAsset.content?.sections || []).map((section: any, idx: number) => (
                            <div key={idx} className="space-y-3">
                              <h4 className="font-bold text-lg uppercase tracking-tight">{section.heading}</h4>
                              <p className="text-sm leading-relaxed opacity-70">{section.body}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </div>

            {/* Asset History Sidebar */}
            <div className="space-y-6">
              <h3 className="text-xs font-mono uppercase tracking-widest opacity-50">Generated Assets</h3>
              <div className="space-y-3">
                {assetHistory.length === 0 && (
                  <div className="p-8 border border-dashed border-[#141414]/20 text-center rounded-xl">
                    <p className="text-[10px] font-mono opacity-40 uppercase">No assets yet</p>
                  </div>
                )}
                {assetHistory.map((asset) => (
                  <div 
                    key={asset.id}
                    onClick={() => setSelectedAsset(asset)}
                    className={`p-4 border border-[#141414] shadow-[2px_2px_0px_0px_rgba(20,20,20,1)] flex items-center justify-between group cursor-pointer transition-all ${selectedAsset?.id === asset.id ? 'bg-[#141414] text-white shadow-none translate-x-[2px] translate-y-[2px]' : 'bg-white hover:bg-[#F5F5F5]'}`}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      {asset.type === 'ppt' ? <Presentation className={`w-4 h-4 ${selectedAsset?.id === asset.id ? 'text-orange-400' : 'text-orange-600'}`} /> : <FileIcon className={`w-4 h-4 ${selectedAsset?.id === asset.id ? 'text-blue-400' : 'text-blue-600'}`} />}
                      <div className="overflow-hidden">
                        <p className="text-xs font-bold truncate">{asset.filename}</p>
                        <p className={`text-[8px] font-mono uppercase ${selectedAsset?.id === asset.id ? 'opacity-60' : 'opacity-40'}`}>{new Date(asset.created_at!).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadExistingAsset(asset);
                      }}
                      className={`p-2 rounded-lg transition-all ${selectedAsset?.id === asset.id ? 'hover:bg-white/10' : 'hover:bg-[#141414] hover:text-white'}`}
                    >
                      <Download className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
