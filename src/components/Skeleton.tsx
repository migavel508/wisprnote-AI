import { motion } from 'framer-motion';

interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circular' | 'rectangular' | 'card';
  width?: string | number;
  height?: string | number;
  count?: number;
}

// Base skeleton with shimmer animation
export function Skeleton({ 
  className = '', 
  variant = 'rectangular',
  width,
  height,
  count = 1
}: SkeletonProps) {
  const baseClasses = 'bg-gray-200 animate-pulse';
  
  const variantClasses = {
    text: 'h-4 rounded',
    circular: 'rounded-full',
    rectangular: 'rounded-lg',
    card: 'rounded-xl'
  };

  const style: React.CSSProperties = {
    width: width || '100%',
    height: height || (variant === 'text' ? '1rem' : variant === 'circular' ? width : '100%')
  };

  if (count > 1) {
    return (
      <div className="space-y-2">
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className={`${baseClasses} ${variantClasses[variant]} ${className}`}
            style={style}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`${baseClasses} ${variantClasses[variant]} ${className}`}
      style={style}
    />
  );
}

// Meeting card skeleton
export function MeetingCardSkeleton() {
  return (
    <div className="border border-gray-200 bg-white p-6 rounded-lg">
      <div className="flex justify-between items-start mb-4">
        <Skeleton variant="rectangular" width={40} height={40} />
        <Skeleton variant="text" width={80} height={12} />
      </div>
      <Skeleton variant="text" width="70%" height={16} className="mb-2" />
      <Skeleton variant="text" count={2} className="mb-4" />
      <Skeleton variant="text" width={100} height={12} />
    </div>
  );
}

// Meeting cards grid skeleton
export function MeetingGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <MeetingCardSkeleton key={i} />
      ))}
    </div>
  );
}

// Notes page skeleton
export function NotesPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton variant="text" width={200} height={24} />
          <Skeleton variant="text" width={120} height={14} />
        </div>
        <Skeleton variant="rectangular" width={100} height={36} />
      </div>
      
      {/* Tabs */}
      <div className="flex gap-2">
        <Skeleton variant="rectangular" width={100} height={36} />
        <Skeleton variant="rectangular" width={100} height={36} />
        <Skeleton variant="rectangular" width={100} height={36} />
      </div>
      
      {/* Content */}
      <div className="space-y-4">
        <Skeleton variant="text" count={8} />
      </div>
    </div>
  );
}

// Chat page skeleton
export function ChatPageSkeleton() {
  return (
    <div className="flex flex-col h-full p-4">
      {/* Header */}
      <div className="flex items-center gap-3 pb-4 border-b">
        <Skeleton variant="circular" width={40} height={40} />
        <div className="space-y-1">
          <Skeleton variant="text" width={150} height={16} />
          <Skeleton variant="text" width={100} height={12} />
        </div>
      </div>
      
      {/* Messages */}
      <div className="flex-1 py-4 space-y-4">
        <div className="flex justify-start">
          <Skeleton variant="rectangular" width="60%" height={60} className="rounded-2xl" />
        </div>
        <div className="flex justify-end">
          <Skeleton variant="rectangular" width="50%" height={40} className="rounded-2xl" />
        </div>
        <div className="flex justify-start">
          <Skeleton variant="rectangular" width="70%" height={80} className="rounded-2xl" />
        </div>
      </div>
      
      {/* Input */}
      <div className="pt-4 border-t">
        <Skeleton variant="rectangular" height={48} className="rounded-full" />
      </div>
    </div>
  );
}

// Assets page skeleton
export function AssetsPageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Skeleton variant="text" width={180} height={24} />
        <Skeleton variant="rectangular" width={120} height={36} />
      </div>
      
      {/* Asset cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border border-gray-200 bg-white p-5 rounded-xl">
            <div className="flex items-start gap-4">
              <Skeleton variant="rectangular" width={48} height={48} />
              <div className="flex-1 space-y-2">
                <Skeleton variant="text" width="60%" height={16} />
                <Skeleton variant="text" width="80%" height={12} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Knowledge graph skeleton
export function KnowledgeGraphSkeleton() {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="space-y-1">
          <Skeleton variant="text" width={180} height={24} />
          <Skeleton variant="text" width={280} height={12} />
        </div>
        <div className="flex gap-2">
          <Skeleton variant="rectangular" width={100} height={36} />
          <Skeleton variant="rectangular" width={100} height={36} />
        </div>
      </div>
      
      {/* Graph area */}
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center space-y-4">
          <div className="relative w-48 h-48 mx-auto">
            {/* Simulated graph nodes */}
            <Skeleton variant="circular" width={40} height={40} className="absolute top-0 left-1/2 -translate-x-1/2" />
            <Skeleton variant="circular" width={30} height={30} className="absolute top-1/3 left-0" />
            <Skeleton variant="circular" width={30} height={30} className="absolute top-1/3 right-0" />
            <Skeleton variant="circular" width={24} height={24} className="absolute bottom-1/4 left-1/4" />
            <Skeleton variant="circular" width={24} height={24} className="absolute bottom-1/4 right-1/4" />
            <Skeleton variant="circular" width={20} height={20} className="absolute bottom-0 left-1/2 -translate-x-1/2" />
          </div>
          <Skeleton variant="text" width={150} height={14} className="mx-auto" />
        </div>
      </div>
    </div>
  );
}

// Process page skeleton
export function ProcessPageSkeleton() {
  return (
    <div className="flex flex-col h-full p-6">
      {/* Title */}
      <Skeleton variant="text" width={200} height={32} className="mb-4" />
      
      {/* Tags */}
      <div className="flex gap-2 mb-8">
        <Skeleton variant="rectangular" width={80} height={32} />
        <Skeleton variant="rectangular" width={100} height={32} />
      </div>
      
      {/* Instructions */}
      <div className="mb-6">
        <Skeleton variant="text" width={120} height={12} className="mb-2" />
        <Skeleton variant="rectangular" height={80} />
      </div>
      
      {/* Content area */}
      <div className="flex-1 flex items-center justify-center">
        <Skeleton variant="rectangular" width="100%" height={200} className="max-w-lg" />
      </div>
    </div>
  );
}

// Full page loading skeleton with shimmer
export function PageLoadingSkeleton({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-white">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="text-center"
      >
        <div className="w-12 h-12 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin mx-auto mb-4" />
        <p className="text-sm text-gray-500 font-mono">{message}</p>
      </motion.div>
    </div>
  );
}

export default Skeleton;
