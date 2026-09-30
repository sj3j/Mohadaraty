import React, { useState, useEffect, useRef, useMemo } from 'react';
import { UserProfile, Language } from '../types';
import {
  Folder, FolderPlus, FileText, Upload, ChevronRight, ChevronLeft,
  MoreVertical, Plus, Trash2, Edit3, FolderInput, Search,
  LayoutGrid, List, AlertTriangle, X, Check, Loader2, Sparkles, Eye, Crown
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  UserFolder, UserFile,
  getUserFolders, getAllUserFolders, createUserFolder, renameUserFolder, deleteUserFolderCascade,
  getUserFiles, saveUserFile, renameUserFile, moveUserFile, deleteUserFile,
  countAllUserFiles, FREE_PERSONAL_SPACE_FILE_LIMIT
} from '../lib/localDb';
import { hasSubscriptionAccess } from '../../shared/subscriptionAccess';
import SubscriptionPaywall from './SubscriptionPaywall';

interface PersonalSpaceTabProps {
  user: UserProfile | null;
  lang: Language;
  onOpenLocalPdf: (file: UserFile) => void;
  onNavigateToSubscription?: () => void;
  onShowPaywall?: () => void;
}

const FOLDER_COLORS = [
  { id: 'sky', bg: 'bg-sky-500', text: 'text-sky-500', border: 'border-sky-500', light: 'bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400' },
  { id: 'amber', bg: 'bg-amber-500', text: 'text-amber-500', border: 'border-amber-500', light: 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400' },
  { id: 'emerald', bg: 'bg-emerald-500', text: 'text-emerald-500', border: 'border-emerald-500', light: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400' },
  { id: 'purple', bg: 'bg-purple-500', text: 'text-purple-500', border: 'border-purple-500', light: 'bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400' },
  { id: 'rose', bg: 'bg-rose-500', text: 'text-rose-500', border: 'border-rose-500', light: 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400' },
  { id: 'indigo', bg: 'bg-indigo-500', text: 'text-indigo-500', border: 'border-indigo-500', light: 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400' },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function PersonalSpaceTab({
  user,
  lang,
  onOpenLocalPdf,
  onNavigateToSubscription,
  onShowPaywall,
}: PersonalSpaceTabProps) {
  const isRtl = lang === 'ar';
  const userId = user?.uid || 'guest';
  const isSubscribed = hasSubscriptionAccess(user);

  // Quota and paywall state
  const [totalUserFiles, setTotalUserFiles] = useState<number>(0);
  const [showInternalPaywall, setShowInternalPaywall] = useState<boolean>(false);

  const handleOpenPaywall = () => {
    if (onShowPaywall) {
      onShowPaywall();
    } else {
      setShowInternalPaywall(true);
    }
  };

  // Navigation state
  const [currentFolderId, setCurrentFolderId] = useState<string>(''); // '' represents root
  const [folderHistory, setFolderHistory] = useState<{ id: string; name: string }[]>([]);

  // Data state
  const [folders, setFolders] = useState<UserFolder[]>([]);
  const [files, setFiles] = useState<UserFile[]>([]);
  const [allUserFoldersList, setAllUserFoldersList] = useState<UserFolder[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0);

  // UI state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'size'>('date');
  const [showAddMenu, setShowAddMenu] = useState<boolean>(false);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  // Modals state
  const [showCreateFolderModal, setShowCreateFolderModal] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [selectedColor, setSelectedColor] = useState<string>('sky');

  const [renameTarget, setRenameTarget] = useState<{ type: 'folder' | 'file'; item: UserFolder | UserFile } | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');

  const [moveTarget, setMoveTarget] = useState<UserFile | null>(null);
  const [selectedMoveFolderId, setSelectedMoveFolderId] = useState<string>('');

  const [deleteTarget, setDeleteTarget] = useState<{ type: 'folder' | 'file'; item: UserFolder | UserFile } | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // Context Menu state
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Close add dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
      if (!(e.target as HTMLElement).closest('[data-context-menu]')) {
        setActiveMenuId(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load current folder contents
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    Promise.all([
      getUserFolders(userId, currentFolderId),
      getUserFiles(userId, currentFolderId),
      getAllUserFolders(userId),
      countAllUserFiles(userId),
    ])
      .then(([currentFolders, currentFiles, allFolders, totalFiles]) => {
        if (!cancelled) {
          setFolders(currentFolders);
          setFiles(currentFiles);
          setAllUserFoldersList(allFolders);
          setTotalUserFiles(totalFiles);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load personal space data:', err);
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, currentFolderId, refreshTrigger]);

  // Navigate into a folder
  const handleOpenFolder = (folder: UserFolder) => {
    setFolderHistory((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setCurrentFolderId(folder.id);
    setActiveMenuId(null);
    setSearchQuery('');
  };

  // Navigate back to a specific breadcrumb or parent
  const handleNavigateBreadcrumb = (index: number) => {
    if (index === -1) {
      // Root
      setFolderHistory([]);
      setCurrentFolderId('');
    } else {
      const nextHistory = folderHistory.slice(0, index + 1);
      setFolderHistory(nextHistory);
      setCurrentFolderId(nextHistory[nextHistory.length - 1].id);
    }
    setActiveMenuId(null);
    setSearchQuery('');
  };

  const handleNavigateBack = () => {
    if (folderHistory.length <= 1) {
      handleNavigateBreadcrumb(-1);
    } else {
      handleNavigateBreadcrumb(folderHistory.length - 2);
    }
  };

  // Create folder
  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newFolderName.trim();
    if (!trimmed) return;

    try {
      await createUserFolder({
        userId,
        name: trimmed,
        parentId: currentFolderId || '',
        color: selectedColor,
      });
      setNewFolderName('');
      setShowCreateFolderModal(false);
      setRefreshTrigger((t) => t + 1);
    } catch (err) {
      console.error('Error creating folder:', err);
      alert(isRtl ? 'حدث خطأ أثناء إنشاء المجلد.' : 'Failed to create folder.');
    }
  };

  // Import PDF files
  const handleTriggerFileInput = () => {
    setShowAddMenu(false);
    if (!isSubscribed && totalUserFiles >= FREE_PERSONAL_SPACE_FILE_LIMIT) {
      handleOpenPaywall();
      return;
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    if (!isSubscribed && totalUserFiles >= FREE_PERSONAL_SPACE_FILE_LIMIT) {
      handleOpenPaywall();
      return;
    }

    const availableSlots = isSubscribed
      ? Infinity
      : Math.max(0, FREE_PERSONAL_SPACE_FILE_LIMIT - totalUserFiles);

    const pdfFiles: File[] = [];
    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        pdfFiles.push(file);
      }
    }

    if (pdfFiles.length === 0) return;

    const filesToImport = pdfFiles.slice(0, availableSlots);
    const hasExceededLimit = !isSubscribed && pdfFiles.length > availableSlots;

    if (filesToImport.length === 0) {
      handleOpenPaywall();
      return;
    }

    setIsImporting(true);
    setImportStatus(
      isRtl
        ? `جاري استيراد ${filesToImport.length} ملف...`
        : `Importing ${filesToImport.length} files...`
    );

    let importedCount = 0;
    try {
      for (const file of filesToImport) {
        // Clean file name
        const cleanName = file.name.replace(/\.[^/.]+$/, '');

        await saveUserFile(
          {
            userId,
            folderId: currentFolderId || '',
            name: cleanName,
            size: file.size,
          },
          file
        );
        importedCount++;
      }

      setRefreshTrigger((t) => t + 1);

      if (hasExceededLimit) {
        setImportStatus(
          isRtl
            ? `تم استيراد ${importedCount} ملف. وصلت للحد الأقصى للباقة المجانية (6 ملفات)!`
            : `Imported ${importedCount} files. Reached the free limit (6 files)!`
        );
        setTimeout(() => {
          setImportStatus(null);
          setIsImporting(false);
          handleOpenPaywall();
        }, 1200);
      } else {
        setImportStatus(
          isRtl
            ? `تم استيراد ${importedCount} ملف بنجاح!`
            : `Imported ${importedCount} files successfully!`
        );
        setTimeout(() => {
          setImportStatus(null);
          setIsImporting(false);
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to import files:', err);
      alert(isRtl ? 'حدث خطأ أثناء حفظ الملف محلياً.' : 'Failed to save file locally.');
      setIsImporting(false);
      setImportStatus(null);
    }
  };

  // Rename
  const handleConfirmRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;

    try {
      if (renameTarget.type === 'folder') {
        await renameUserFolder(renameTarget.item.id, trimmed);
      } else {
        await renameUserFile(renameTarget.item.id, trimmed);
      }
      setRenameTarget(null);
      setRefreshTrigger((t) => t + 1);
    } catch (err) {
      console.error('Rename failed:', err);
    }
  };

  // Move File
  const handleConfirmMove = async () => {
    if (!moveTarget) return;
    try {
      await moveUserFile(moveTarget.id, selectedMoveFolderId);
      setMoveTarget(null);
      setRefreshTrigger((t) => t + 1);
    } catch (err) {
      console.error('Move failed:', err);
    }
  };

  // Delete
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      if (deleteTarget.type === 'folder') {
        await deleteUserFolderCascade(userId, deleteTarget.item.id);
      } else {
        await deleteUserFile(deleteTarget.item.id);
      }
      setDeleteTarget(null);
      setRefreshTrigger((t) => t + 1);
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  // Filtered & Sorted items
  const filteredFolders = useMemo(() => {
    let result = [...folders];
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(q));
    }
    return result.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name, isRtl ? 'ar' : 'en');
      return b.createdAt - a.createdAt;
    });
  }, [folders, searchQuery, sortBy, isRtl]);

  const filteredFiles = useMemo(() => {
    let result = [...files];
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(q));
    }
    return result.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name, isRtl ? 'ar' : 'en');
      if (sortBy === 'size') return b.size - a.size;
      return b.createdAt - a.createdAt;
    });
  }, [files, searchQuery, sortBy, isRtl]);

  const currentFolderName = folderHistory.length > 0 ? folderHistory[folderHistory.length - 1].name : (isRtl ? 'مساحتك الرئيسية' : 'Main Space');

  return (
    <div className="space-y-5 pb-28 sm:pb-32" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        accept="application/pdf"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Top Header & Breadcrumbs Bar */}
      <div className="bg-white dark:bg-zinc-800/80 backdrop-blur-md rounded-3xl p-4 sm:p-5 border border-slate-200/80 dark:border-zinc-700/80 shadow-sm transition-all">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          
          {/* Breadcrumb Navigation */}
          <div className="flex items-center gap-1.5 flex-wrap text-sm">
            {folderHistory.length > 0 && (
              <button
                type="button"
                onClick={handleNavigateBack}
                className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 transition-colors mr-1 rtl:mr-0 rtl:ml-1"
                title={isRtl ? 'المجلد السابق' : 'Back'}
              >
                {isRtl ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
              </button>
            )}

            <button
              type="button"
              onClick={() => handleNavigateBreadcrumb(-1)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-2xl font-bold transition-all ${
                folderHistory.length === 0
                  ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 font-black'
                  : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-700/60'
              }`}
            >
              <Folder className="w-4 h-4 text-sky-500 shrink-0" />
              <span>{isRtl ? 'مساحتك' : 'Your Space'}</span>
            </button>

            {folderHistory.map((crumb, idx) => {
              const isLast = idx === folderHistory.length - 1;
              return (
                <React.Fragment key={crumb.id}>
                  <span className="text-slate-300 dark:text-zinc-600">/</span>
                  <button
                    type="button"
                    onClick={() => handleNavigateBreadcrumb(idx)}
                    className={`max-w-[150px] truncate px-3 py-1.5 rounded-2xl font-bold transition-all ${
                      isLast
                        ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 font-black'
                        : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-700/60'
                    }`}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 relative self-end sm:self-auto" ref={addMenuRef}>
            {/* Quota Badge */}
            {isSubscribed ? (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-2xl bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/60 text-xs font-black shadow-xs">
                <Crown className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                <span className="hidden sm:inline">{isRtl ? 'مساحة غير محدودة' : 'Unlimited Space'}</span>
                <span className="sm:hidden">{isRtl ? 'غير محدود' : 'Unlimited'}</span>
              </div>
            ) : (
              <div
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-2xl text-xs font-bold border transition-all ${
                  totalUserFiles >= FREE_PERSONAL_SPACE_FILE_LIMIT
                    ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800'
                    : 'bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border-slate-200/80 dark:border-zinc-700'
                }`}
              >
                <span className="font-mono font-black">
                  {totalUserFiles}/{FREE_PERSONAL_SPACE_FILE_LIMIT}
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:inline">
                  {isRtl ? 'ملفات' : 'files'}
                </span>
                {totalUserFiles >= FREE_PERSONAL_SPACE_FILE_LIMIT && (
                  <button
                    type="button"
                    onClick={handleOpenPaywall}
                    className="flex items-center gap-1 text-[11px] font-black text-amber-600 dark:text-amber-400 hover:text-amber-700 underline underline-offset-2 ml-1 rtl:ml-0 rtl:mr-1 transition"
                  >
                    <Crown className="w-3 h-3 text-amber-500 fill-amber-500" />
                    <span>{isRtl ? 'ترقية' : 'Upgrade'}</span>
                  </button>
                )}
              </div>
            )}

            {/* View Mode Toggle */}
            <div className="flex items-center bg-slate-100 dark:bg-zinc-900 rounded-2xl p-1 border border-slate-200/60 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-xl transition-all ${
                  viewMode === 'grid'
                    ? 'bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 shadow-sm'
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200'
                }`}
                title={isRtl ? 'عرض شبكي' : 'Grid View'}
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-xl transition-all ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 shadow-sm'
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200'
                }`}
                title={isRtl ? 'عرض قائمة' : 'List View'}
              >
                <List className="w-4 h-4" />
              </button>
            </div>

            {/* Main Add Button */}
            <button
              type="button"
              onClick={() => setShowAddMenu((prev) => !prev)}
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 active:scale-95 text-white font-bold rounded-2xl shadow-md shadow-sky-500/20 transition-all text-sm"
            >
              <Plus className="w-4 h-4" />
              <span>{isRtl ? 'إضافة' : 'Add'}</span>
            </button>

            {/* Dropdown Menu */}
            <AnimatePresence>
              {showAddMenu && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 10 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-full mt-2 ltr:right-0 rtl:left-0 z-30 w-52 bg-white dark:bg-zinc-800 rounded-3xl shadow-xl border border-slate-100 dark:border-zinc-700/80 p-2 space-y-1"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddMenu(false);
                      setShowCreateFolderModal(true);
                    }}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-2xl hover:bg-slate-50 dark:hover:bg-zinc-700/50 text-slate-700 dark:text-zinc-200 transition-colors text-sm font-bold"
                  >
                    <div className="w-8 h-8 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                      <FolderPlus className="w-4 h-4" />
                    </div>
                    <span>{isRtl ? 'مجلد جديد' : 'New Folder'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleTriggerFileInput}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-2xl hover:bg-slate-50 dark:hover:bg-zinc-700/50 text-slate-700 dark:text-zinc-200 transition-colors text-sm font-bold"
                  >
                    <div className="w-8 h-8 rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400 flex items-center justify-center">
                      <Upload className="w-4 h-4" />
                    </div>
                    <span>{isRtl ? 'استيراد PDF' : 'Import PDF'}</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Search & Sort Row */}
        <div className="mt-4 pt-4 border-t border-slate-100 dark:border-zinc-700/60 flex flex-col sm:flex-row items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute top-1/2 -translate-y-1/2 ltr:left-3 rtl:right-3 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={isRtl ? 'بحث في مساحتك...' : 'Search in space...'}
              className="w-full ltr:pl-9 rtl:pr-9 ltr:pr-8 rtl:pl-8 py-2 bg-slate-50 dark:bg-zinc-900 border border-slate-200/80 dark:border-zinc-700/80 rounded-2xl text-xs sm:text-sm text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-500 transition-all placeholder:text-slate-400"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute top-1/2 -translate-y-1/2 ltr:right-2.5 rtl:left-2.5 p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Sort Selector */}
          <div className="flex items-center gap-2 self-start sm:self-auto text-xs text-slate-500 dark:text-zinc-400">
            <span>{isRtl ? 'الترتيب:' : 'Sort:'}</span>
            <div className="flex items-center gap-1 bg-slate-50 dark:bg-zinc-900 p-1 rounded-xl border border-slate-200/60 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setSortBy('date')}
                className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                  sortBy === 'date'
                    ? 'bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 shadow-xs'
                    : 'hover:text-slate-700 dark:hover:text-zinc-200'
                }`}
              >
                {isRtl ? 'الأحدث' : 'Date'}
              </button>
              <button
                type="button"
                onClick={() => setSortBy('name')}
                className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                  sortBy === 'name'
                    ? 'bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 shadow-xs'
                    : 'hover:text-slate-700 dark:hover:text-zinc-200'
                }`}
              >
                {isRtl ? 'الاسم' : 'Name'}
              </button>
              <button
                type="button"
                onClick={() => setSortBy('size')}
                className={`px-2.5 py-1 rounded-lg font-bold transition-all ${
                  sortBy === 'size'
                    ? 'bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 shadow-xs'
                    : 'hover:text-slate-700 dark:hover:text-zinc-200'
                }`}
              >
                {isRtl ? 'الحجم' : 'Size'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Importing Toast */}
      <AnimatePresence>
        {isImporting && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex items-center gap-3 p-3.5 bg-sky-50 dark:bg-sky-950/50 border border-sky-200 dark:border-sky-800 text-sky-800 dark:text-sky-200 rounded-2xl shadow-xs text-sm font-bold"
          >
            <Loader2 className="w-4 h-4 animate-spin text-sky-600" />
            <span>{importStatus}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading state */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <Loader2 className="w-8 h-8 animate-spin text-sky-500 mb-2" />
          <p className="text-sm font-medium">{isRtl ? 'جاري تحميل ملفات مساحتك...' : 'Loading your space...'}</p>
        </div>
      ) : filteredFolders.length === 0 && filteredFiles.length === 0 ? (
        /* Empty State */
        <div className="text-center py-16 px-4 bg-white/70 dark:bg-zinc-800/70 backdrop-blur-sm rounded-3xl border-2 border-dashed border-slate-200 dark:border-zinc-700 flex flex-col items-center justify-center">
          <div className="w-16 h-16 rounded-3xl bg-sky-500/10 text-sky-600 dark:text-sky-400 flex items-center justify-center mb-4 shadow-inner">
            <FolderPlus className="w-8 h-8" />
          </div>
          <h3 className="text-base sm:text-lg font-black text-slate-800 dark:text-zinc-100 mb-1">
            {searchQuery
              ? (isRtl ? 'لا توجد نتائج بحث مطابقة' : 'No matching items')
              : (isRtl ? 'مساحتك فارغة حالياً' : 'Your space is empty')}
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-zinc-400 max-w-md mx-auto mb-6">
            {searchQuery
              ? (isRtl ? 'جرّب البحث باسم ملف أو مجلد آخر.' : 'Try searching for another name.')
              : (isRtl
                  ? 'أنشئ مجلداتك الخاصة واستورد ملفات PDF للدراسة وتدوين الملاحظات محلياً بدون إنترنت.'
                  : 'Create folders and import PDF files to study and annotate offline without internet.')}
          </p>
          {!searchQuery && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowCreateFolderModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 font-bold rounded-2xl text-xs sm:text-sm transition-all"
              >
                <FolderPlus className="w-4 h-4" />
                <span>{isRtl ? 'مجلد جديد' : 'New Folder'}</span>
              </button>
              <button
                type="button"
                onClick={handleTriggerFileInput}
                className="flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-2xl text-xs sm:text-sm shadow-md shadow-sky-600/20 transition-all"
              >
                <Upload className="w-4 h-4" />
                <span>{isRtl ? 'استيراد PDF' : 'Import PDF'}</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Folders Section */}
          {filteredFolders.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-xs font-black text-slate-400 dark:text-zinc-500 uppercase tracking-wider px-1">
                {isRtl ? `المجلدات (${filteredFolders.length})` : `Folders (${filteredFolders.length})`}
              </h4>

              <div
                className={
                  viewMode === 'grid'
                    ? 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5'
                    : 'space-y-2'
                }
              >
                {filteredFolders.map((folder) => {
                  const colorConfig = FOLDER_COLORS.find((c) => c.id === folder.color) || FOLDER_COLORS[0];
                  return (
                    <motion.div
                      key={folder.id}
                      layout
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className={`group relative bg-white dark:bg-zinc-800 rounded-3xl p-3.5 sm:p-4 border border-slate-200/80 dark:border-zinc-700/80 hover:border-sky-400/60 dark:hover:border-sky-500/60 transition-all shadow-xs hover:shadow-md cursor-pointer flex items-center justify-between gap-3 ${
                        viewMode === 'list' ? 'py-3' : ''
                      }`}
                      onClick={() => handleOpenFolder(folder)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-11 h-11 rounded-2xl ${colorConfig.light} flex items-center justify-center shrink-0 shadow-xs`}
                        >
                          <Folder className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h5 className="font-bold text-sm text-slate-800 dark:text-zinc-100 truncate group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
                            {folder.name}
                          </h5>
                          <span className="text-[11px] text-slate-400 dark:text-zinc-500">
                            {new Date(folder.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US')}
                          </span>
                        </div>
                      </div>

                      {/* Folder Context Menu Button */}
                      <div
                        className="relative"
                        data-context-menu
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setActiveMenuId(activeMenuId === folder.id ? null : folder.id)
                          }
                          className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 transition-colors"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {/* Menu Dropdown */}
                        <AnimatePresence>
                          {activeMenuId === folder.id && (
                            <motion.div
                              initial={{ opacity: 0, scale: 0.95 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.95 }}
                              className="absolute top-full mt-1 ltr:right-0 rtl:left-0 z-40 w-40 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl border border-slate-100 dark:border-zinc-700 p-1.5 space-y-0.5 text-xs font-bold"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setRenameTarget({ type: 'folder', item: folder });
                                  setRenameValue(folder.name);
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-zinc-700/60 text-slate-700 dark:text-zinc-200 transition-colors"
                              >
                                <Edit3 className="w-3.5 h-3.5 text-slate-400" />
                                <span>{isRtl ? 'إعادة تسمية' : 'Rename'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setDeleteTarget({ type: 'folder', item: folder });
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>{isRtl ? 'حذف' : 'Delete'}</span>
                              </button>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Files Section */}
          {filteredFiles.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-xs font-black text-slate-400 dark:text-zinc-500 uppercase tracking-wider px-1">
                {isRtl ? `ملفات الـ PDF (${filteredFiles.length})` : `PDF Files (${filteredFiles.length})`}
              </h4>

              <div
                className={
                  viewMode === 'grid'
                    ? 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5'
                    : 'space-y-2'
                }
              >
                {filteredFiles.map((file) => (
                  <motion.div
                    key={file.id}
                    layout
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className={`group relative bg-white dark:bg-zinc-800 rounded-3xl p-4 border border-slate-200/80 dark:border-zinc-700/80 hover:border-sky-400/60 dark:hover:border-sky-500/60 transition-all shadow-xs hover:shadow-md cursor-pointer flex flex-col justify-between gap-3 ${
                      viewMode === 'list' ? 'flex-row items-center py-3' : ''
                    }`}
                    onClick={() => onOpenLocalPdf(file)}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-2xl bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0 shadow-xs">
                        <FileText className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h5 className="font-bold text-sm text-slate-800 dark:text-zinc-100 line-clamp-2 group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors leading-snug">
                          {file.name}
                        </h5>
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400 dark:text-zinc-500 font-medium">
                          <span>{formatBytes(file.size)}</span>
                          <span>•</span>
                          <span>{new Date(file.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US')}</span>
                        </div>
                      </div>
                    </div>

                    {/* Bottom Row / Actions */}
                    <div
                      className={`flex items-center justify-between pt-2 border-t border-slate-100 dark:border-zinc-750 ${
                        viewMode === 'list' ? 'border-t-0 pt-0 shrink-0 gap-2' : ''
                      }`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => onOpenLocalPdf(file)}
                        className="flex items-center gap-1.5 text-xs font-bold text-sky-600 dark:text-sky-400 hover:underline"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{isRtl ? 'فتح في القارئ' : 'Open in Reader'}</span>
                      </button>

                      {/* File Context Menu Button */}
                      <div className="relative" data-context-menu>
                        <button
                          type="button"
                          onClick={() =>
                            setActiveMenuId(activeMenuId === file.id ? null : file.id)
                          }
                          className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 transition-colors"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {/* File Menu Dropdown */}
                        <AnimatePresence>
                          {activeMenuId === file.id && (
                            <motion.div
                              initial={{ opacity: 0, scale: 0.95 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.95 }}
                              className="absolute bottom-full mb-1 ltr:right-0 rtl:left-0 z-40 w-44 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl border border-slate-100 dark:border-zinc-700 p-1.5 space-y-0.5 text-xs font-bold"
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  onOpenLocalPdf(file);
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-zinc-700/60 text-slate-700 dark:text-zinc-200 transition-colors"
                              >
                                <Eye className="w-3.5 h-3.5 text-sky-500" />
                                <span>{isRtl ? 'قراءة الملف' : 'Read'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setRenameTarget({ type: 'file', item: file });
                                  setRenameValue(file.name);
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-zinc-700/60 text-slate-700 dark:text-zinc-200 transition-colors"
                              >
                                <Edit3 className="w-3.5 h-3.5 text-slate-400" />
                                <span>{isRtl ? 'إعادة تسمية' : 'Rename'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setMoveTarget(file);
                                  setSelectedMoveFolderId(file.folderId || '');
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-zinc-700/60 text-slate-700 dark:text-zinc-200 transition-colors"
                              >
                                <FolderInput className="w-3.5 h-3.5 text-slate-400" />
                                <span>{isRtl ? 'نقل إلى مجلد' : 'Move to...'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveMenuId(null);
                                  setDeleteTarget({ type: 'file', item: file });
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/40 text-rose-600 dark:text-rose-400 transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>{isRtl ? 'حذف' : 'Delete'}</span>
                              </button>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: Create New Folder                                                  */}
      {/* ========================================================================= */}
      <AnimatePresence>
        {showCreateFolderModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-md bg-white dark:bg-zinc-800 rounded-3xl p-6 shadow-2xl border border-slate-100 dark:border-zinc-700 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                    <FolderPlus className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-black text-base text-slate-900 dark:text-zinc-100">
                      {isRtl ? 'إنشاء مجلد جديد' : 'New Folder'}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      {isRtl ? `داخل: ${currentFolderName}` : `Inside: ${currentFolderName}`}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCreateFolderModal(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 rounded-xl"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleCreateFolder} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-1.5">
                    {isRtl ? 'اسم المجلد' : 'Folder Name'}
                  </label>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    placeholder={isRtl ? 'مثال: الباطنية، ملخصات...' : 'e.g. Surgery, Summaries...'}
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-2xl text-sm text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-500 font-medium"
                  />
                </div>

                {/* Color Selector */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-2">
                    {isRtl ? 'لون المجلد' : 'Folder Color'}
                  </label>
                  <div className="flex items-center gap-2.5">
                    {FOLDER_COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setSelectedColor(c.id)}
                        className={`w-8 h-8 rounded-full ${c.bg} flex items-center justify-center transition-all ${
                          selectedColor === c.id ? 'ring-3 ring-offset-2 ring-sky-500 scale-110' : 'opacity-80 hover:opacity-100'
                        }`}
                      >
                        {selectedColor === c.id && <Check className="w-4 h-4 text-white" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateFolderModal(false)}
                    className="px-4 py-2 text-xs font-bold text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-xl transition-colors"
                  >
                    {isRtl ? 'إلغاء' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 text-xs font-black bg-sky-600 hover:bg-sky-700 text-white rounded-xl shadow-md shadow-sky-600/20 transition-all"
                  >
                    {isRtl ? 'إنشاء' : 'Create'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ========================================================================= */}
      {/* MODAL: Rename Target (Folder or File)                                      */}
      {/* ========================================================================= */}
      <AnimatePresence>
        {renameTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-md bg-white dark:bg-zinc-800 rounded-3xl p-6 shadow-2xl border border-slate-100 dark:border-zinc-700 space-y-4"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-black text-base text-slate-900 dark:text-zinc-100">
                  {renameTarget.type === 'folder'
                    ? (isRtl ? 'إعادة تسمية المجلد' : 'Rename Folder')
                    : (isRtl ? 'إعادة تسمية الملف' : 'Rename File')}
                </h3>
                <button
                  type="button"
                  onClick={() => setRenameTarget(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 rounded-xl"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleConfirmRename} className="space-y-4">
                <div>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-2xl text-sm text-slate-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-500 font-medium"
                  />
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRenameTarget(null)}
                    className="px-4 py-2 text-xs font-bold text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-xl transition-colors"
                  >
                    {isRtl ? 'إلغاء' : 'Cancel'}
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 text-xs font-black bg-sky-600 hover:bg-sky-700 text-white rounded-xl shadow-md shadow-sky-600/20 transition-all"
                  >
                    {isRtl ? 'حفظ' : 'Save'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ========================================================================= */}
      {/* MODAL: Move File to Folder                                                */}
      {/* ========================================================================= */}
      <AnimatePresence>
        {moveTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-md bg-white dark:bg-zinc-800 rounded-3xl p-6 shadow-2xl border border-slate-100 dark:border-zinc-700 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-black text-base text-slate-900 dark:text-zinc-100">
                    {isRtl ? 'نقل الملف إلى مجلد' : 'Move File to Folder'}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-zinc-400 truncate max-w-xs mt-0.5">
                    {moveTarget.name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setMoveTarget(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-zinc-200 rounded-xl"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Folder list */}
              <div className="max-h-60 overflow-y-auto space-y-1.5 py-1">
                {/* Root Option */}
                <button
                  type="button"
                  onClick={() => setSelectedMoveFolderId('')}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-xs sm:text-sm font-bold transition-all ${
                    selectedMoveFolderId === ''
                      ? 'bg-sky-50 dark:bg-sky-950/50 text-sky-600 dark:text-sky-400 border border-sky-300 dark:border-sky-800'
                      : 'hover:bg-slate-50 dark:hover:bg-zinc-700/50 text-slate-700 dark:text-zinc-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Folder className="w-4 h-4 text-sky-500" />
                    <span>{isRtl ? 'المساحة الرئيسية (الجذر)' : 'Main Space (Root)'}</span>
                  </div>
                  {selectedMoveFolderId === '' && <Check className="w-4 h-4" />}
                </button>

                {allUserFoldersList.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setSelectedMoveFolderId(f.id)}
                    className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-xs sm:text-sm font-bold transition-all ${
                      selectedMoveFolderId === f.id
                        ? 'bg-sky-50 dark:bg-sky-950/50 text-sky-600 dark:text-sky-400 border border-sky-300 dark:border-sky-800'
                        : 'hover:bg-slate-50 dark:hover:bg-zinc-700/50 text-slate-700 dark:text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                      <span className="truncate">{f.name}</span>
                    </div>
                    {selectedMoveFolderId === f.id && <Check className="w-4 h-4 shrink-0" />}
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMoveTarget(null)}
                  className="px-4 py-2 text-xs font-bold text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-xl transition-colors"
                >
                  {isRtl ? 'إلغاء' : 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmMove}
                  className="px-5 py-2 text-xs font-black bg-sky-600 hover:bg-sky-700 text-white rounded-xl shadow-md shadow-sky-600/20 transition-all"
                >
                  {isRtl ? 'نقل الآن' : 'Move Now'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ========================================================================= */}
      {/* MODAL: Delete Confirmation (Cascade safe)                                 */}
      {/* ========================================================================= */}
      <AnimatePresence>
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-md bg-white dark:bg-zinc-800 rounded-3xl p-6 shadow-2xl border border-slate-100 dark:border-zinc-700 space-y-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-rose-500/15 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-black text-base text-slate-900 dark:text-zinc-100">
                    {deleteTarget.type === 'folder'
                      ? (isRtl ? 'تأكيد حذف المجلد' : 'Delete Folder')
                      : (isRtl ? 'تأكيد حذف الملف' : 'Delete File')}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-zinc-400 font-medium">
                    {deleteTarget.item.name}
                  </p>
                </div>
              </div>

              <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-200/80 dark:border-rose-900/60 rounded-2xl p-3.5 text-xs text-rose-800 dark:text-rose-300 space-y-1">
                {deleteTarget.type === 'folder' ? (
                  <p>
                    {isRtl
                      ? 'تنبيه: سيتم حذف هذا المجلد وجميع الملفات والمجلدات الفرعية الموجودة بداخله نهائياً من الذاكرة المحلية.'
                      : 'Warning: This folder and all files and subfolders inside it will be permanently deleted from local storage.'}
                  </p>
                ) : (
                  <p>
                    {isRtl
                      ? 'سيتم حذف ملف الـ PDF نهائياً من مساحتك المحلية لتحرير المساحة.'
                      : 'This PDF file will be permanently removed from your local space.'}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => setDeleteTarget(null)}
                  className="px-4 py-2 text-xs font-bold text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-xl transition-colors"
                >
                  {isRtl ? 'إلغاء' : 'Cancel'}
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={handleConfirmDelete}
                  className="px-5 py-2 text-xs font-black bg-rose-600 hover:bg-rose-700 text-white rounded-xl shadow-md shadow-rose-600/20 transition-all flex items-center gap-1.5"
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{isRtl ? 'جاري الحذف...' : 'Deleting...'}</span>
                    </>
                  ) : (
                    <span>{isRtl ? 'حذف نهائي' : 'Delete Permanently'}</span>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ========================================================================= */}
      {/* MODAL: Subscription Paywall                                               */}
      {/* ========================================================================= */}
      {showInternalPaywall && (
        <SubscriptionPaywall
          lang={lang}
          onClose={() => setShowInternalPaywall(false)}
          onSubscribe={() => {
            setShowInternalPaywall(false);
            if (onNavigateToSubscription) {
              onNavigateToSubscription();
            }
          }}
        />
      )}
    </div>
  );
}
