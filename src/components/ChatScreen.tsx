import React, { useState, useEffect, useRef } from "react";
import { Language, TRANSLATIONS, UserProfile } from "../types";
import { isMasterAdminEmail } from "../../shared/masterAdmins";
import {
  Send,
  Settings,
  Trash2,
  Power,
  Clock,
  StopCircle,
  RefreshCw,
  Archive,
  Bell,
  MessageSquare,
  Paperclip,
  X,
  ThumbsUp,
  Heart,
  Image as ImageIcon,
  FileText,
  Link,
  Eye,
  Users,
  Flag,
} from "lucide-react";
import {
  collection,
  query,
  orderBy,
  getDocs,
  addDoc,
  serverTimestamp,
  deleteDoc,
  doc,
  getDoc,
  updateDoc,
  writeBatch,
  limit,
  where,
  arrayUnion,
  arrayRemove,
  onSnapshot,
  getCountFromServer,
  setDoc,
} from "firebase/firestore";
import {
  db,
  storage,
  functions,
  handleFirestoreError,
  OperationType,
} from "../lib/firebase";
import { httpsCallable } from "firebase/functions";
import { motion, AnimatePresence } from "motion/react";
import ReportMessageSheet from "./chat/ReportMessageSheet";
import { filterBlocked } from "../services/moderationService";
import { forceDownload } from "../lib/utils";
import { useStageContext } from "../contexts/StageContext";
import { canManage } from '../lib/permissions';

interface ChatMessage {
  id: string;
  text: string;
  senderName: string;
  senderEmail: string;
  senderAvatar: string;
  senderId?: string;
  timestamp: any;
  createdAt: number;
  replyTo?: {
    messageId: string;
    senderName: string;
    text: string;
  } | null;
  reactions?: {
    like: string[];
    heart: string[];
    thanks: string[];
    viewers?: string[];
  };
  viewers?: string[];
  isAnonymous?: boolean;
  isPending?: boolean;
  originalSenderName?: string;
  originalSenderExamCode?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: "image" | "file";
  embeddedItem?: {
    type: "lecture" | "record" | "announcement";
    id: string;
    title: string;
    subtitle?: string;
    link?: string;
  } | null;
  status?: "pending" | "failed" | "sent";
  error?: string;
}

interface PrivateAccount {
  id: string;
  title: string; // e.g. "حساب الممثل"
  name: string; // admin's name
  email: string; // admin's email
}

type ChatType = 'group' | 'private';

interface ActiveChat {
  type: ChatType;
  id: string;
  name?: string;
  title?: string;
  otherEmail?: string;
}

interface ChatSettings {
  isChatOpen: boolean;
  messageCooldown: number;
  closedMessage: string;
  allowAttachments?: boolean;
  pinnedMessage?: {
    id: string;
    text: string;
    senderName: string;
  } | null;
  privateAccounts?: PrivateAccount[];
}

interface ChatScreenProps {
  user: UserProfile | null;
  lang: Language;
  setCurrentTab?: (tab: string) => void;
  onMobileChatOpenChange?: (isOpen: boolean) => void;
}

const MessageBubble = React.memo(
  ({
    msg,
    isMe,
    showHeader,
    timeStr,
    isRtl,
    user,
    isMasterAdmin,
    isAdminOrModerator,
    revealedMessages,
    showReactionPickerFor,
    setShowReactionPickerFor,
    handleReaction,
    setReplyingTo,
    setMessageToDelete,
    setRevealedMessages,
    setCurrentTab,
    CHAT_DOC_ID,
    renderMessageText,
    appUsers,
    onReportMessage,
  }: any) => {
    const liveUser = appUsers?.find((u: any) => u.email === msg.senderEmail);
    const displayAvatar = msg.isAnonymous ? "?" : (liveUser && !liveUser.hidePhotoOnLeaderboard && liveUser.photoUrl) || msg.senderAvatar;

    return (
      <div
        id={`msg-${msg.id}`}
        data-message-id={msg.id}
        data-sender-id={msg.senderId}
        className={`message-bubble-container flex w-full transition-colors duration-500 rounded-lg ${isMe ? "justify-end" : "justify-start"}`}
      >
        <div
          className={`flex max-w-[85%] sm:max-w-[75%] gap-2 ${isMe ? "flex-row-reverse" : "flex-row"}`}
        >
          {/* Avatar */}
          {showHeader && !isMe && (
            <div
              className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center mt-1 font-bold text-sm overflow-hidden border ${msg.isAnonymous ? "bg-amber-200 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 border-amber-100 dark:border-zinc-800" : "bg-sky-200 dark:bg-sky-900/60 text-sky-700 dark:text-sky-300 border-sky-100 dark:border-zinc-800"}`}
            >
              {msg.isAnonymous ? (
                "?"
              ) : displayAvatar?.startsWith("http") ? (
                <img
                  src={displayAvatar}
                  alt={msg.senderName}
                  loading="lazy"
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                displayAvatar || msg.senderName.charAt(0).toUpperCase()
              )}
            </div>
          )}
          {!showHeader && !isMe && <div className="w-8 flex-shrink-0" />}

          {/* Bubble */}
          <div
            className={`group relative flex flex-col ${isMe ? "items-end" : "items-start"}`}
          >
            {showHeader && (
              <span
                className={`text-xs font-bold ${isMe ? "mr-1 rtl:mr-0 rtl:ml-1 text-right" : "ml-1 rtl:ml-0 rtl:mr-1"} mb-1 ${msg.isAnonymous ? "text-amber-500" : "text-slate-500 dark:text-slate-400"}`}
              >
                {msg.isAnonymous && isMe
                  ? isRtl
                    ? "أنت (مجهول)"
                    : "You (Anonymous)"
                  : msg.senderName}
                {isMasterAdminEmail(msg.senderEmail) &&
                  !msg.isAnonymous && (
                    <span className="text-sky-500 text-[10px] bg-sky-100 dark:bg-sky-900/40 px-1.5 py-0.5 rounded ml-1">
                      Admin
                    </span>
                  )}
              </span>
            )}

            <div
              className={`relative px-3 sm:px-4 pt-2 pb-1.5 shadow-sm text-[15px] cursor-pointer transition-colors ${
                isMe
                  ? msg.isAnonymous
                    ? "bg-amber-600 text-white rounded-[18px] rounded-br-[4px] rtl:rounded-br-[18px] rtl:rounded-bl-[4px]"
                    : "bg-sky-600 text-white rounded-[18px] rounded-br-[4px] rtl:rounded-br-[18px] rtl:rounded-bl-[4px]"
                  : msg.isAnonymous
                    ? "bg-amber-50 dark:bg-amber-900/20 text-slate-800 dark:text-slate-200 rounded-[18px] rounded-bl-[4px] rtl:rounded-bl-[18px] rtl:rounded-br-[4px] border border-amber-200 dark:border-amber-900/50"
                    : "bg-white dark:bg-zinc-800 text-slate-800 dark:text-slate-200 rounded-[18px] rounded-bl-[4px] rtl:rounded-bl-[18px] rtl:rounded-br-[4px] border border-slate-100 dark:border-zinc-700"
              }`}
              onClick={() => {
                setShowReactionPickerFor(
                  showReactionPickerFor === msg.id ? null : msg.id,
                );
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setShowReactionPickerFor(
                  showReactionPickerFor === msg.id ? null : msg.id,
                );
              }}
            >
              {revealedMessages.has(msg.id) &&
                isMasterAdmin &&
                msg.isAnonymous && (
                  <div
                    className="absolute -top-6 bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-200 text-[10px] font-bold px-2 py-0.5 rounded shadow-sm border border-amber-200 dark:border-amber-700 min-w-max"
                    style={{ [isRtl ? "right" : "left"]: "0" }}
                  >
                    {msg.senderEmail || msg.senderId || "Unknown"} (Email)
                  </div>
                )}

              {msg.replyTo && (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    const el = document.getElementById(
                      `msg-${msg.replyTo!.messageId}`,
                    );
                    if (el) {
                      el.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                      el.classList.add("bg-sky-100", "dark:bg-sky-900/40");
                      setTimeout(
                        () =>
                          el.classList.remove(
                            "bg-sky-100",
                            "dark:bg-sky-900/40",
                          ),
                        2000,
                      );
                    }
                  }}
                  className={`mb-1.5 p-2 rounded-lg text-xs border-l-2 rtl:border-l-0 rtl:border-r-2 cursor-pointer hover:opacity-80 transition-opacity ${isMe ? "bg-sky-700/50 border-sky-300" : "bg-slate-100 dark:bg-zinc-700/50 border-sky-500"}`}
                >
                  <div className="font-bold mb-0.5 opacity-90">
                    {msg.replyTo.senderName}
                  </div>
                  <div className="opacity-80 truncate" dir="auto">
                    {msg.replyTo.text}
                  </div>
                </div>
              )}

              {msg.fileUrl && (
                <div className="mb-2">
                  {msg.fileType === "image" ? (
                    <a
                      href={msg.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <img
                        src={msg.fileUrl}
                        alt="attachment"
                        loading="lazy"
                        className="max-w-full max-h-64 rounded-lg object-contain cursor-zoom-in"
                      />
                    </a>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        forceDownload(
                          msg.fileUrl!,
                          msg.fileName || "Attachment",
                        );
                      }}
                      className={`flex items-center gap-2 p-3 rounded-xl border ${isMe ? "bg-sky-700/30 border-sky-500/50 text-white hover:bg-sky-700/50" : "bg-slate-50 dark:bg-zinc-800/50 border-slate-200 dark:border-zinc-700 text-sky-600 dark:text-sky-400 hover:bg-slate-100 dark:hover:bg-zinc-800/80"} transition-colors text-left`}
                    >
                      <Paperclip className="w-5 h-5" />
                      <span className="text-sm font-medium truncate max-w-[200px]">
                        {msg.fileName || "Attachment"}
                      </span>
                    </button>
                  )}
                </div>
              )}

              {msg.embeddedItem && (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    if (setCurrentTab) {
                      if (msg.embeddedItem!.type === "lecture")
                        setCurrentTab("lectures");
                      else if (msg.embeddedItem!.type === "record")
                        setCurrentTab("records");
                      else if (msg.embeddedItem!.type === "announcement")
                        setCurrentTab("announcements");
                    }
                  }}
                  className={`mb-2 p-3 rounded-xl border flex flex-col gap-1 cursor-pointer hover:opacity-90 ${isMe ? "bg-sky-700/30 border-sky-500/50" : "bg-slate-50 dark:bg-zinc-800/50 border-slate-200 dark:border-zinc-700"}`}
                >
                  <div className="flex items-center gap-1.5 opacity-80 text-[10px] uppercase font-bold tracking-wider">
                    {msg.embeddedItem.type === "lecture" && (
                      <span className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 px-1.5 py-0.5 rounded">
                        Lecture
                      </span>
                    )}
                    {msg.embeddedItem.type === "record" && (
                      <span className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300 px-1.5 py-0.5 rounded">
                        Record
                      </span>
                    )}
                    {msg.embeddedItem.type === "announcement" && (
                      <span className="bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 px-1.5 py-0.5 rounded">
                        Announcement
                      </span>
                    )}
                  </div>
                  <div className="font-bold hover:underline line-clamp-2 text-sm">
                    {msg.embeddedItem.title}
                  </div>
                  {msg.embeddedItem.subtitle && (
                    <span className="text-xs opacity-70 truncate">
                      {msg.embeddedItem.subtitle}
                    </span>
                  )}
                </div>
              )}

              <div className="flex flex-col">
                <p
                  className="whitespace-pre-wrap break-words leading-relaxed"
                  dir="auto"
                >
                  {renderMessageText(msg.text)}
                </p>
  
                <div
                  className={`flex items-center justify-end mt-1 gap-1 -mb-1 opacity-70 float-right ${isMe ? "text-sky-100" : "text-slate-400"}`}
                >
                  <span className="text-[10.5px] font-medium leading-tight">{timeStr}</span>
                </div>
              </div>
            </div>

            {/* Reactions Display */}
            {msg.reactions &&
              (msg.reactions.like?.length > 0 ||
                msg.reactions.heart?.length > 0 ||
                msg.reactions.thanks?.length > 0) && (
                <div
                  className={`flex flex-wrap gap-1 mt-1 z-10 ${isMe ? "justify-end" : "justify-start"}`}
                >
                  {msg.reactions.like?.length > 0 && (
                    <button
                      title={msg.reactions.like.join(", ")}
                      onClick={() =>
                        handleReaction(msg.id, "like", msg.reactions)
                      }
                      className={`px-1.5 py-0.5 rounded-full text-xs flex items-center gap-1 border hover:scale-105 transition-transform ${msg.reactions.like.includes(user?.email || "") ? "bg-sky-50 dark:bg-sky-900 border-sky-200 text-sky-700" : "bg-white dark:bg-zinc-800 border-slate-200 text-slate-600"}`}
                    >
                      👍 {msg.reactions.like.length}
                    </button>
                  )}
                  {msg.reactions.heart?.length > 0 && (
                    <button
                      title={msg.reactions.heart.join(", ")}
                      onClick={() =>
                        handleReaction(msg.id, "heart", msg.reactions)
                      }
                      className={`px-1.5 py-0.5 rounded-full text-xs flex items-center gap-1 border hover:scale-105 transition-transform ${msg.reactions.heart.includes(user?.email || "") ? "bg-rose-50 dark:bg-rose-900 border-rose-200 text-rose-700" : "bg-white dark:bg-zinc-800 border-slate-200 text-slate-600"}`}
                    >
                      ❤️ {msg.reactions.heart.length}
                    </button>
                  )}
                  {msg.reactions.thanks?.length > 0 && (
                    <button
                      title={msg.reactions.thanks.join(", ")}
                      onClick={() =>
                        handleReaction(msg.id, "thanks", msg.reactions)
                      }
                      className={`px-1.5 py-0.5 rounded-full text-xs flex items-center gap-1 border hover:scale-105 transition-transform ${msg.reactions.thanks.includes(user?.email || "") ? "bg-emerald-50 dark:bg-emerald-900 border-emerald-200 text-emerald-700" : "bg-white dark:bg-zinc-800 border-slate-200 text-slate-600"}`}
                    >
                      🙏 {msg.reactions.thanks.length}
                    </button>
                  )}
                </div>
              )}

            {/* Reaction / Action Picker */}
            <AnimatePresence>
              {showReactionPickerFor === msg.id && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 10 }}
                  className={`absolute -top-16 z-[100] bg-white dark:bg-zinc-800 shadow-2xl rounded-2xl px-3 py-2 flex items-center gap-2 border border-slate-200 dark:border-zinc-700 whitespace-nowrap ${isMe ? (isRtl ? "left-0" : "right-0") : isRtl ? "right-0" : "left-0"}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-1.5 border-r dark:border-zinc-700 pr-2 rtl:pr-0 rtl:pl-2 rtl:border-r-0 rtl:border-l">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReaction(msg.id, "like", msg.reactions);
                        setShowReactionPickerFor(null);
                      }}
                      className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-full transition-colors text-xl"
                    >
                      👍
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReaction(msg.id, "heart", msg.reactions);
                        setShowReactionPickerFor(null);
                      }}
                      className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-full transition-colors text-xl"
                    >
                      ❤️
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReaction(msg.id, "thanks", msg.reactions);
                        setShowReactionPickerFor(null);
                      }}
                      className="w-8 h-8 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-full transition-colors text-xl"
                    >
                      🙏
                    </button>
                  </div>

                  <div
                    className="flex items-center gap-1 px-2 text-xs font-bold text-slate-500 dark:text-slate-400 border-r dark:border-zinc-700 pr-2 rtl:pr-0 rtl:pl-2 rtl:border-r-0 rtl:border-l"
                    title={isRtl ? "المشاهدات" : "Views"}
                  >
                    <Eye className="w-4 h-4" />
                    <span>
                      {msg.reactions?.viewers || msg.viewers
                        ? (msg.reactions?.viewers || msg.viewers)!.length
                        : 0}
                    </span>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setReplyingTo({
                        messageId: msg.id,
                        senderName: msg.senderName,
                        text: msg.text.substring(0, 50),
                        senderId: msg.senderId,
                      });
                      setShowReactionPickerFor(null);
                    }}
                    className="px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-xl text-xs font-bold text-sky-600 flex items-center gap-1.5"
                  >
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 17 4 12 9 7" />
                      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                    </svg>
                    {isRtl ? "رد" : "Reply"}
                  </button>

                  {!isMe && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onReportMessage?.(msg);
                        setShowReactionPickerFor(null);
                      }}
                      className="p-1.5 hover:bg-rose-50 dark:hover:bg-rose-900/30 text-slate-400 hover:text-rose-500 rounded-full transition-colors"
                      title={isRtl ? "إبلاغ" : "Report"}
                    >
                      <Flag className="w-4 h-4" />
                    </button>
                  )}

                  {(isAdminOrModerator || isMe) && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setMessageToDelete(msg.id);
                        setShowReactionPickerFor(null);
                      }}
                      className="p-1.5 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-500 rounded-full transition-colors"
                      title={isRtl ? "حذف" : "Delete"}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}

                  {isMasterAdmin && msg.isAnonymous && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRevealedMessages((prev: any) => {
                          const next = new Set(prev);
                          if (next.has(msg.id)) next.delete(msg.id);
                          else next.add(msg.id);
                          return next;
                        });
                        setShowReactionPickerFor(null);
                      }}
                      title={
                        isRtl ? "كشف/إخفاء الهوية" : "Toggle Reveal Identity"
                      }
                      className={`p-1.5 hover:bg-amber-50 dark:hover:bg-amber-900/30 text-amber-500 rounded-full transition-colors ${revealedMessages.has(msg.id) ? "bg-amber-100 dark:bg-amber-900/50" : ""}`}
                    >
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                  )}

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowReactionPickerFor(null);
                    }}
                    className="p-1.5 hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-full text-slate-400 group"
                  >
                    <X className="w-4 h-4 group-hover:text-red-500 transition-colors" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Desktop Hover Actions (Optional, kept but integrated with tap logic above) */}
            {(isAdminOrModerator || isMe) && (
              <div
                className={`absolute top-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 hidden sm:flex ${isMe ? "-left-10 rtl:left-auto rtl:-right-10 flex-row" : "-right-10 rtl:right-auto rtl:-left-10 flex-row-reverse"}`}
              >
                <button
                  onClick={() => {
                    setMessageToDelete(msg.id);
                  }}
                  className={`p-1.5 bg-red-100 dark:bg-red-900 text-red-600 dark:text-red-400 rounded-full shadow-sm hover:scale-110`}
                  title={isRtl ? "حذف الرسالة" : "Delete"}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>

                {isAdminOrModerator && (
                  <button
                    onClick={() => {
                      updateDoc(doc(db, "chat_settings", CHAT_DOC_ID), {
                        pinnedMessage: {
                          id: msg.id,
                          text: msg.text,
                          senderName: msg.senderName,
                        },
                      });
                    }}
                    className="p-1.5 bg-sky-100 dark:bg-sky-900 text-sky-600 dark:text-sky-400 rounded-full shadow-sm hover:scale-110"
                    title={isRtl ? "تثبيت الرسالة" : "Pin Message"}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 17v5" />
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                  </button>
                )}

                {isMasterAdmin && msg.isAnonymous && (
                  <button
                    onClick={() => {
                      setRevealedMessages((prev: any) => {
                        const next = new Set(prev);
                        if (next.has(msg.id)) next.delete(msg.id);
                        else next.add(msg.id);
                        return next;
                      });
                    }}
                    title={
                      isRtl ? "كشف/إخفاء الهوية" : "Toggle Reveal Identity"
                    }
                    className={`p-1.5 bg-amber-100 dark:bg-amber-900 text-amber-600 dark:text-amber-400 rounded-full shadow-sm hover:scale-110 ${revealedMessages.has(msg.id) ? "ring-2 ring-amber-400" : ""}`}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);

export default function ChatScreen({
  user,
  lang,
  setCurrentTab,
  onMobileChatOpenChange
}: ChatScreenProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === "ar";
  const isAdminOrModerator = canManage(user, 'manageChat');
  const isMasterAdmin = user?.isMasterAdmin;
  const CHAT_DOC_ID = "config";
  const { effectiveStageId } = useStageContext();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<ChatSettings>({
    isChatOpen: false,
    messageCooldown: 30,
    closedMessage: "الشات مغلق حالياً",
  });

  const [newMessage, setNewMessage] = useState("");
  const [replyingTo, setReplyingTo] = useState<{
    messageId: string;
    senderName: string;
    text: string;
    senderId?: string;
  } | null>(null);
  const [showReactionPickerFor, setShowReactionPickerFor] = useState<
    string | null
  >(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const isSendingRef = useRef(false);
  const [lastMessageTime, setLastMessageTime] = useState<number>(0);
  const [totalUsersCount, setTotalUsersCount] = useState<number>(0);
  const [showAdminControls, setShowAdminControls] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showAccountsManage, setShowAccountsManage] = useState(false);
  const [newAccount, setNewAccount] = useState<Partial<PrivateAccount>>({});
  const [messageToDelete, setMessageToDelete] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [isAnonymous, setIsAnonymous] = useState(false);
  
  const [activeChat, setActiveChat] = useState<ActiveChat>({ type: 'group', id: 'group', name: isRtl ? 'شات الدفعة' : 'Group Chat' });
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);
  const [activeChatFilter, setActiveChatFilter] = useState<'all' | 'personal' | 'groups'>('all');
  const [inboxSessions, setInboxSessions] = useState<any[]>([]);
  const [appUsers, setAppUsers] = useState<any[]>([]);

  // Fetch app users for account selection & avatars
  useEffect(() => {
    if (appUsers.length === 0) {
      const fetchUsers = async () => {
        try {
          const q = query(collection(db, "users"));
          const snapshot = await getDocs(q);
          const usersData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
          setAppUsers(usersData);
        } catch (e) {
          console.error("Failed to load users", e);
        }
      };
      fetchUsers();
    }
  }, [db]);

  // Load inbox sessions if admin
  useEffect(() => {
    if (onMobileChatOpenChange) {
      onMobileChatOpenChange(isMobileChatOpen);
    }
  }, [isMobileChatOpen, onMobileChatOpenChange]);

  useEffect(() => {
     if (!isAdminOrModerator || !user?.email) return;
     const unsub = onSnapshot(
        query(collection(db, "inbox_sessions"), where("adminEmail", "==", user.email)),
        (snap) => {
           const sorted = snap.docs.map(d => d.data()).sort((a: any, b: any) => b.updatedAt - a.updatedAt);
           setInboxSessions(sorted);
        },
        (error) => { console.warn("Cannot listen to inbox_sessions:", error); }
     );
     return () => unsub();
  }, [isAdminOrModerator, user?.email]);

  // Attachments & Embds
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [attachmentType, setAttachmentType] = useState<"image" | "file" | null>(
    null,
  );
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [embeddedItem, setEmbeddedItem] = useState<
    ChatMessage["embeddedItem"] | null
  >(null);
  const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);

  // Mention states
  const [mentionSearch, setMentionSearch] = useState<string | null>(null);
  const [mentionUsersPool, setMentionUsersPool] = useState<
    { id: string; name: string; photoUrl?: string; hidePhoto?: boolean }[]
  >([]);
  const [mentionFiltered, setMentionFiltered] = useState<
    { id: string; name: string; photoUrl?: string; hidePhoto?: boolean }[]
  >([]);

  // Typing Indicator states
  const [isTyping, setIsTyping] = useState(false);
  const [activeTypers, setActiveTypers] = useState<string[]>([]);

  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [revealedMessages, setRevealedMessages] = useState<Set<string>>(
    new Set(),
  );

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Track last visible document for pagination
  const [lastVisibleMessageId, setLastVisibleMessageId] = useState<
    string | null
  >(null);
  const [hasMore, setHasMore] = useState(true);

  // Ghost sender bug fix & rendering cleanup
  const getIsMe = (msg: ChatMessage) => {
    return !!(
      user &&
      ((msg.senderEmail && user.email === msg.senderEmail) ||
        (msg.senderId && user.uid === msg.senderId))
    );
  };
  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };


  // Fetch Total Students Count
  useEffect(() => {
    const fetchTotalUsers = async () => {
      try {
        // Only count students
        const qStudents = query(
          collection(db, "users"),
          where("role", "==", "student"),
        );
        const totalUsersSnapshot = await getCountFromServer(qStudents);
        setTotalUsersCount(totalUsersSnapshot.data().count);
      } catch (err) {}
    };

    fetchTotalUsers();
  }, []);

  // Typing State Tracking & Sync
  useEffect(() => {
    if (!user || (!newMessage.trim() && !mentionSearch)) {
      if (isTyping) setIsTyping(false);
      return;
    }
    setIsTyping(true);
    const timeout = setTimeout(() => setIsTyping(false), 3000);
    return () => clearTimeout(timeout);
  }, [newMessage, mentionSearch]);

  useEffect(() => {
    if (!user) return;
    const typingRef = doc(db, "chat_typing", user.uid);
    if (isTyping) {
      setDoc(typingRef, {
        name:
          user.hideNameOnLeaderboard && !isAdminOrModerator
            ? isRtl
              ? "مستخدم مجهول"
              : "Anonymous User"
            : user.name,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    } else {
      deleteDoc(typingRef).catch(() => {});
    }
    return () => {
      deleteDoc(typingRef).catch(() => {});
    };
  }, [isTyping, user?.uid]);

  // Listen to other users typing
  useEffect(() => {
    if (!user) return;
    const qTyping = query(collection(db, "chat_typing"));
    const unsub = onSnapshot(
      qTyping,
      (snapshot) => {
        const now = Date.now();
        const typers: string[] = [];
        snapshot.forEach((docSnap) => {
          if (docSnap.id === user.uid) return; // ignore self
          const data = docSnap.data();
          const ts = new Date(data.timestamp).getTime();
          // Keep active if updated within last 10 seconds
          if (now - ts < 10000 && data.name) {
            typers.push(data.name);
          }
        });
        setActiveTypers(typers);
      },
      (error) => {
        console.error("Typing listener permission or index error:", error);
        handleFirestoreError(error, OperationType.LIST, "chat_typing");
      },
    );
    return () => unsub();
  }, [user?.uid]);

  // Real-time Settings Listener
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "chat_settings", CHAT_DOC_ID),
      (docSnap) => {
        const defaultSettings: ChatSettings = {
          isChatOpen: true,
          messageCooldown: 0,
          closedMessage: "الشات مغلق حالياً",
          allowAttachments: true,
        };

        if (docSnap.exists()) {
          const data = docSnap.data() as Partial<ChatSettings>;
          setSettings((prev) => ({ ...prev, ...data }));

          // Failsafe: if the document exists but is missing 'isChatOpen', write it to the DB so live rules don't crash.
          if (isAdminOrModerator && data.isChatOpen === undefined) {
            setDoc(
              doc(db, "chat_settings", CHAT_DOC_ID),
              { isChatOpen: true },
              { merge: true },
            ).catch(console.error);
          }
        } else if (isAdminOrModerator) {
          // Initialize if not exists
          setDoc(doc(db, "chat_settings", CHAT_DOC_ID), defaultSettings, {
            merge: true,
          }).catch(() => {});
          setSettings(defaultSettings);
        }
      },
      (e) => {
        console.error("Settings listener error:", e);
        handleFirestoreError(e, OperationType.GET, "chat_settings/config");
      },
    );
    return () => unsub();
  }, [isAdminOrModerator]);

  const currentChatCollectionPath = activeChat.type === 'group' ? 'chat_messages' : `private_chats/${activeChat.id}/messages`;

  /** Message being reported, or null. Drives ReportMessageSheet. */
  const [reportTarget, setReportTarget] = useState<{
    messageId: string; messageText: string;
    senderId?: string | null; senderName?: string | null; chatPath: string;
  } | null>(null);

  // Listen for Live Messages (Replacing Polling)
  useEffect(() => {
    setIsLoading(true);
    setMessages([]);
    const constraints = activeChat.type === 'group' ? [where("stageId", "==", effectiveStageId)] : [];

    const q = query(
      collection(db, currentChatCollectionPath),
      ...constraints,
      orderBy("createdAt", "desc"),
      limit(50),
    );

    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        setMessages((prev) => {
          let newArray = [...prev];
          snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            const msg: ChatMessage = {
              id: change.doc.id,
              text: data.text || "",
              senderName:
                data.senderName ||
                (data.senderEmail
                  ? data.senderEmail.split("@")[0]
                  : "مستخدم محذوف"),
              senderEmail: data.senderEmail || "",
              senderId: data.senderId || "",
              senderAvatar: data.senderAvatar || "",
              timestamp: data.timestamp,
              createdAt: data.timestamp
                ? data.timestamp.toMillis()
                : data.createdAt || Date.now(),
              replyTo: data.replyTo || null,
              reactions: data.reactions || { like: [], heart: [], thanks: [] },
              isAnonymous: data.isAnonymous || false,
              isPending: change.doc.metadata.hasPendingWrites,
              originalSenderName: data.originalSenderName || "",
              fileUrl: data.fileUrl || undefined,
              fileName: data.fileName || undefined,
              fileType: data.fileType || undefined,
              embeddedItem: data.embeddedItem || undefined,
            };

            if (change.type === "added") {
              const idx = newArray.findIndex((m) => m.id === msg.id);
              if (idx >= 0) {
                if (!data.timestamp && newArray[idx].createdAt) {
                  msg.createdAt = newArray[idx].createdAt; // Prevent Date.now() drift
                }
                newArray[idx] = msg;
              } else {
                newArray.push(msg);
              }
            }
            if (change.type === "modified") {
              const idx = newArray.findIndex((m) => m.id === msg.id);
              if (idx >= 0) {
                if (!data.timestamp && newArray[idx].createdAt) {
                  msg.createdAt = newArray[idx].createdAt;
                }
                newArray[idx] = msg;
              }
            }
            if (change.type === "removed") {
              newArray = newArray.filter((m) => m.id !== msg.id);
            }
          });

          // Return chronologically sorted array
          newArray.sort((a, b) => a.createdAt - b.createdAt);
          return newArray;
        });

        if (!snapshot.empty) {
          setLastVisibleMessageId(snapshot.docs[snapshot.docs.length - 1].id);
        }
        setIsLoading(false);

        // Auto scroll down if user is near bottom
        const container = containerRef.current;
        if (container) {
          const isNearBottom =
            container.scrollHeight -
              container.scrollTop -
              container.clientHeight <
            150;
          if (isNearBottom) {
            setTimeout(() => scrollToBottom(), 100);
            setUnreadCount(0);
          } else {
            // Check if there are real added messages from other people
            if (
              snapshot
                .docChanges()
                .some(
                  (c) =>
                    c.type === "added" && c.doc.data().senderId !== user?.uid,
                )
            ) {
              setUnreadCount((prev) => prev + 1);
            }
          }
        }
      },
      (e) => {
        console.error("Chat live listener error: ", e);
        setIsLoading(false);
        handleFirestoreError(e, OperationType.LIST, currentChatCollectionPath);
      },
    );

    return () => unsubscribe();
  }, [currentChatCollectionPath, activeChat.type, effectiveStageId]);

  // Mention handling
  useEffect(() => {
    const match = newMessage.match(/@([^\s]*)$/);
    if (match) {
      const search = match[1].toLowerCase();
      setMentionSearch(search);

      if (mentionUsersPool.length === 0) {
        getDocs(collection(db, "users"))
          .then((snap) => {
            const users = snap.docs.map((d) => ({
              id: d.id,
              name: (d.data().hideNameOnLeaderboard
                ? isRtl
                  ? "مستخدم مجهول"
                  : "Anonymous User"
                : d.data().name) as string,
              photoUrl: d.data().photoUrl as string | undefined,
              hidePhoto: (d.data().hidePhotoOnLeaderboard ||
                d.data().hideNameOnLeaderboard) as boolean | undefined,
            }));
            setMentionUsersPool(users);
            setMentionFiltered(
              users
                .filter(
                  (u) => u.name && u.name.toLowerCase().startsWith(search),
                )
                .slice(0, 5),
            );
          })
          .catch(() => {});
      } else {
        setMentionFiltered(
          mentionUsersPool
            .filter((u) => u.name && u.name.toLowerCase().startsWith(search))
            .slice(0, 5),
        );
      }
    } else {
      setMentionSearch(null);
    }
  }, [newMessage, mentionUsersPool]);

  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSendingRef.current || isSending) return;
    if (
      (!newMessage.trim() && !attachmentFile && !embeddedItem) ||
      (!settings.isChatOpen && !isAdminOrModerator) ||
      !user ||
      isUploadingAttachment
    )
      return;

    isSendingRef.current = true;
    setIsSending(true);

    if (!isAdminOrModerator) {
      if (attachmentFile && settings.allowAttachments === false) {
        setAlertMessage(
          isRtl ? "المرفقات معطلة للطلاب" : "Attachments disabled for students",
        );
        setAttachmentFile(null);
        isSendingRef.current = false;
        setIsSending(false);
        return;
      }
    }

    const messageText = newMessage.trim();
    const replyData = replyingTo ? { ...replyingTo } : null;
    const embedData = embeddedItem ? { ...embeddedItem } : null;
    let finalFileUrl = "";
    let finalFileName = "";
    let finalFileType = attachmentType;

    setIsUploadingAttachment(!!attachmentFile);

    try {
      const docRef = doc(collection(db, currentChatCollectionPath));

      if (attachmentFile) {
        const {
          ref: storageRef,
          uploadBytes,
          getDownloadURL,
        } = await import("firebase/storage");
        const ext = attachmentFile.name.split(".").pop();
        const safeName = Math.random().toString(36).substring(2, 10);
        const fileRef = storageRef(
          storage,
          `chat_attachments/${user.uid}_${Date.now()}_${safeName}.${ext}`,
        );

        await uploadBytes(fileRef, attachmentFile);
        finalFileUrl = await getDownloadURL(fileRef);
        finalFileName = attachmentFile.name;
      }

      setNewMessage("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      setReplyingTo(null);
      setAttachmentFile(null);
      setAttachmentType(null);
      setEmbeddedItem(null);
      setShowAttachmentMenu(false);

      const isAnon = !isAdminOrModerator && isAnonymous && activeChat.type === 'group';
      const displaySenderName = isAnon
        ? isRtl
          ? "مجهول"
          : "Anonymous"
        : user.name;
      const displaySenderAvatar = isAnon
        ? "?"
        : user.photoUrl || user.name.charAt(0).toUpperCase();

      const payload: any = {
        text: messageText,
        senderName: displaySenderName,
        senderEmail: user.email,
        senderId: user.uid,
        senderAvatar: displaySenderAvatar,
        timestamp: serverTimestamp(),
        createdAt: Date.now(),
        replyTo: replyData,
        reactions: { like: [], heart: [], thanks: [] },
        isAnonymous: isAnon,
        originalSenderName: user.name,
        originalSenderExamCode: user.examCode || "",
        ...(activeChat.type === 'group' ? { stageId: effectiveStageId } : {}),
      };

      if (finalFileUrl) {
        payload.fileUrl = finalFileUrl;
        payload.fileName = finalFileName;
        payload.fileType = finalFileType;
      }

      if (embedData) {
        payload.embeddedItem = embedData;
      }

      if (isAnon) {
        setIsAnonymous(false);
      }

      let inboxSessionData: any = null;
      if (activeChat.type === 'private') {
         inboxSessionData = {
            id: activeChat.id,
            adminEmail: isAdminOrModerator ? user.email : activeChat.otherEmail,
            studentEmail: isAdminOrModerator ? activeChat.otherEmail : user.email,
            studentName: isAdminOrModerator ? activeChat.name : user.name,
            adminName: isAdminOrModerator ? user.name : activeChat.name,
            lastMessage: payload.text || 'Attachment',
            updatedAt: Date.now()
         };
         
         if (isAdminOrModerator) {
            setDoc(doc(db, "inbox_sessions", activeChat.id), inboxSessionData, { merge: true }).catch(console.error);
         }
      }

      // Optimistic UI update instantly before network wait
      setMessages((prev) => {
        if (prev.some((m) => m.id === docRef.id)) return prev;
        return [
          ...prev,
          {
            id: docRef.id,
            text: messageText,
            senderName: displaySenderName,
            senderEmail: user.email,
            senderId: user.uid,
            senderAvatar: displaySenderAvatar,
            timestamp: new Date() as any,
            createdAt: payload.createdAt,
            replyTo: replyData,
            reactions: { like: [], heart: [], thanks: [] },
            isAnonymous: isAnon,
            isPending: true,
            status: "pending",
            originalSenderName: user.name,
            originalSenderExamCode: user.examCode || "",
            fileUrl: finalFileUrl || undefined,
            fileName: finalFileName || undefined,
            fileType: finalFileUrl ? finalFileType! : undefined,
            embeddedItem: embedData || undefined,
          },
        ];
      });
      // Fire scroll instantly, then again to guarantee layout recalculation
      scrollToBottom();
      setTimeout(() => scrollToBottom(), 50);
      setUnreadCount(0);

      if (isAdminOrModerator) {
         if (payload.isAnonymous) {
            delete payload.senderEmail;
            delete payload.senderId;
            const batch = writeBatch(db);
            // payload already has timestamp: serverTimestamp() so it's fine, but we're destructing
            batch.set(docRef, { ...payload, createdAt: Date.now(), timestamp: serverTimestamp() });
            batch.set(doc(db, `${currentChatCollectionPath}/${docRef.id}/private/sender`), {
              senderEmail: user.email,
              senderId: user.uid
            });
            batch.commit().catch((e: any) => {
              console.error("Failed to send anon msgs", e);
              setAlertMessage(e instanceof Error ? e.message : String(e));
              setMessages((prev) => prev.filter((m) => m.id !== docRef.id));
            });
         } else {
            setDoc(docRef, { ...payload, createdAt: Date.now(), timestamp: serverTimestamp() }).catch((e: any) => {
               console.error("Failed to send msg", e);
               setAlertMessage(e instanceof Error ? e.message : String(e));
               // Revert optimistic UI
               setMessages((prev) => prev.filter((m) => m.id !== docRef.id));
            });
         }
      } else {
         const cleanPayload = { ...payload };
         delete cleanPayload.timestamp; // Remove FieldValue because it's unserializable

         const sendMessageObj: any = {
            messageId: docRef.id,
            message: cleanPayload,
            collectionPath: currentChatCollectionPath
         };
         if (inboxSessionData) {
            sendMessageObj.inboxSession = inboxSessionData;
         }
         // It's removed from public payload for students in cloud function
         
         const sendMessageCallable = httpsCallable<{ messageId: string, message: any, collectionPath: string }, { id: string }>(functions, 'sendMessage');
         sendMessageCallable(sendMessageObj).then((res) => {
            // Success, remove temp message (the real one will come from snapshot)
            setMessages((prev) => prev.filter((m) => m.id !== docRef.id));
         }).catch((error) => {
            console.error("Failed to send message", error);
            // Replace with a failed message indicator!
            setAlertMessage(error instanceof Error ? error.message : String(error));
            setMessages((prev) =>
              prev.map((m) =>
                m.id === docRef.id ? { ...m, isPending: false, status: "failed", error: error.message } as any : m,
              ),
            );
         });
      }

      isSendingRef.current = false;
      setIsSending(false);
      setIsUploadingAttachment(false);
    } catch (e: any) {
      console.error("Failed to prepare message", e);
      setAlertMessage(e instanceof Error ? e.message : String(e));
      isSendingRef.current = false;
      setIsSending(false);
      setIsUploadingAttachment(false);
    }
  };

  const handleLoadMore = async () => {
    setIsLoadingMore(true);

    try {
      if (messages.length === 0) return;
      const oldestMessage = messages[0];

      const constraints = activeChat.type === 'group' ? [where("stageId", "==", effectiveStageId)] : [];

      const q = query(
        collection(db, currentChatCollectionPath),
        ...constraints,
        orderBy("createdAt", "desc"),
        where("createdAt", "<", oldestMessage.createdAt),
        limit(50),
      );

      let snapshot;
      try {
        const { getDocsFromCache } = await import("firebase/firestore");
        snapshot = await getDocsFromCache(q);
        if (snapshot.empty) throw new Error("Cache empty");
      } catch (e) {
        snapshot = await getDocs(q);
      }

      const oldMessages: ChatMessage[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        oldMessages.push({
          id: doc.id,
          text: data.text || "",
          senderName:
            data.senderName ||
            (data.senderEmail
              ? data.senderEmail.split("@")[0]
              : "مستخدم محذوف"),
          senderEmail: data.senderEmail || "",
          senderId: data.senderId || "",
          senderAvatar: data.senderAvatar || "",
          timestamp: data.timestamp,
          createdAt: data.timestamp?.toMillis() || Date.now(),
          replyTo: data.replyTo || null,
          reactions: data.reactions || { like: [], heart: [], thanks: [] },
          isAnonymous: data.isAnonymous || false,
          originalSenderName: data.originalSenderName || "",
          originalSenderExamCode: data.originalSenderExamCode || "",
          fileUrl: data.fileUrl || undefined,
          fileName: data.fileName || undefined,
          fileType: data.fileType || undefined,
          embeddedItem: data.embeddedItem || undefined,
        });
      });

      if (oldMessages.length > 0) {
        setMessages((prev) => {
          const uniqueOld = oldMessages
            .reverse()
            .filter((nm) => !prev.some((pm) => pm.id === nm.id));
          return [...uniqueOld, ...prev];
        });
        setHasMore(oldMessages.length === 20);
      } else {
        setHasMore(false);
      }
    } catch (e) {
      console.error("Failed to load more messages", e);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleViewPinnedMessage = async (targetId: string) => {
    let el = document.getElementById(`msg-${targetId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(
        "ring-2",
        "ring-sky-500",
        "bg-sky-50",
        "dark:bg-sky-900/20",
        "transition-all",
        "duration-500",
      );
      setTimeout(
        () =>
          el.classList.remove(
            "ring-2",
            "ring-sky-500",
            "bg-sky-50",
            "dark:bg-sky-900/20",
            "transition-all",
            "duration-500",
          ),
        2500,
      );
      return;
    }

    if (!hasMore || messages.length === 0) {
      setAlertMessage(
        isRtl ? "تعذر العثور على الرسالة." : "Message could not be found.",
      );
      return;
    }

    // Auto-load previous messages
    setIsLoadingMore(true);
    try {
      const { getDoc, query, collection, orderBy, where, limit, getDocs } =
        await import("firebase/firestore");
      const targetDoc = await getDoc(doc(db, currentChatCollectionPath, targetId));

      if (!targetDoc.exists()) {
        setAlertMessage(isRtl ? "الرسالة محذوفة." : "Message deleted.");
        return;
      }

      const targetTimestamp = targetDoc.data().createdAt;
      if (!targetTimestamp) return;

      const oldestLoaded = messages[0];
      if (oldestLoaded && oldestLoaded.createdAt > targetTimestamp) {
        const constraints = activeChat.type === 'group' ? [where("stageId", "==", effectiveStageId)] : [];

        const q = query(
          collection(db, currentChatCollectionPath),
          ...constraints,
          orderBy("createdAt", "desc"),
          where("createdAt", "<", oldestLoaded.createdAt),
          where("createdAt", ">=", targetTimestamp),
          limit(150),
        );

        const snap = await getDocs(q);
        const oldMsgs: ChatMessage[] = [];
        snap.forEach((docSnap) => {
          const data = docSnap.data();
          oldMsgs.push({
            id: docSnap.id,
            text: data.text || "",
            senderName:
              data.senderName ||
              (data.senderEmail
                ? data.senderEmail.split("@")[0]
                : "مستخدم محذوف"),
            senderEmail: data.senderEmail || "",
            senderId: data.senderId || "",
            senderAvatar: data.senderAvatar || "",
            timestamp: data.timestamp,
            createdAt: data.timestamp?.toMillis() || Date.now(),
            replyTo: data.replyTo || null,
            reactions: data.reactions || { like: [], heart: [], thanks: [] },
            isAnonymous: data.isAnonymous || false,
            originalSenderName: data.originalSenderName || "",
            originalSenderExamCode: data.originalSenderExamCode || "",
            fileUrl: data.fileUrl || undefined,
            fileName: data.fileName || undefined,
            fileType: data.fileType || undefined,
            embeddedItem: data.embeddedItem || undefined,
          });
        });

        if (oldMsgs.length > 0) {
          setMessages((prev) => {
            const uniqueOld = oldMsgs
              .reverse()
              .filter((nm) => !prev.some((pm) => pm.id === nm.id));
            return [...uniqueOld, ...prev];
          });
        }

        setTimeout(() => {
          const afterEl = document.getElementById(`msg-${targetId}`);
          if (afterEl) {
            afterEl.scrollIntoView({ behavior: "smooth", block: "center" });
            afterEl.classList.add(
              "ring-2",
              "ring-sky-500",
              "bg-sky-50",
              "dark:bg-sky-900/20",
              "transition-all",
              "duration-500",
            );
            setTimeout(() => {
              afterEl.classList.remove(
                "ring-2",
                "ring-sky-500",
                "bg-sky-50",
                "dark:bg-sky-900/20",
                "transition-all",
                "duration-500",
              );
            }, 2500);
          } else {
            setAlertMessage(
              isRtl
                ? "الرسالة أقدم من الحد الأقصى للتحميل التلقائي."
                : "Message is older than the auto-load limit.",
            );
          }
        }, 500); // give React more time to mount the new elements
      } else {
        setAlertMessage(
          isRtl
            ? "تعذر العثور على الرسالة في النطاق الزمني."
            : "Could not find message in time range.",
        );
      }
    } catch (e) {
      console.error("Jump error", e);
      setAlertMessage(
        isRtl ? "حدث خطأ أثناء تحميل الرسالة." : "Error loading message.",
      );
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Admin Actions
  const toggleChatStatus = async () => {
    try {
      const newState = !settings.isChatOpen;
      await updateDoc(doc(db, "chat_settings", CHAT_DOC_ID), {
        isChatOpen: newState,
      });
      setSettings((prev) => ({ ...prev, isChatOpen: newState }));
    } catch (e) {
      console.error("Failed to toggle chat state", e);
    }
  };

  const updateCooldown = async (val: number) => {
    try {
      await updateDoc(doc(db, "chat_settings", CHAT_DOC_ID), {
        messageCooldown: val,
      });
      setSettings((prev) => ({ ...prev, messageCooldown: val }));
    } catch (e) {
      console.error("Failed to update cooldown", e);
    }
  };

  const deleteMessage = async (id: string) => {
    const msg = messages.find((m) => m.id === id);
    const isOwner =
      msg &&
      user &&
      (msg.senderId === user.uid ||
        (msg.senderEmail && msg.senderEmail === user.email));

    if (!isAdminOrModerator && !isOwner) return;

    try {
      await deleteDoc(doc(db, currentChatCollectionPath, id));
      setMessages((prev) => prev.filter((m) => m.id !== id));
    } catch (e: any) {
      console.error("Failed to delete message", e);
      setAlertMessage(
        isRtl ? "فشل الحذف. " + e.message : "Failed to delete: " + e.message,
      );
    }
  };

  const clearAllMessages = async () => {
    if (!isAdminOrModerator) return;
    setIsClearing(true);
    try {
      let documentCount = 0;
      let q = query(collection(db, currentChatCollectionPath), limit(500));
      let snapshot = await getDocs(q);

      while (!snapshot.empty) {
        const batch = writeBatch(db);
        snapshot.docs.forEach((doc) => {
          batch.delete(doc.ref);
          documentCount++;
        });
        await batch.commit();

        // fetch the next 500
        q = query(collection(db, currentChatCollectionPath), limit(500));
        snapshot = await getDocs(q);
      }
      setMessages([]);
      setShowClearConfirm(false);
      setAlertMessage(
        isRtl
          ? `تم حذف جميع الرسائل. (${documentCount} رسالة)`
          : `Successfully cleared all messages. (${documentCount} messages)`,
      );
    } catch (e) {
      console.error("Failed to clear messages", e);
      setAlertMessage(
        isRtl ? "حدث خطأ أثناء حذف الرسائل" : "Error clearing messages",
      );
    } finally {
      setIsClearing(false);
    }
  };

  const handleReaction = async (
    msgId: string,
    emoji: "like" | "heart" | "thanks",
    msgReactions: any,
  ) => {
    if (!user) return;
    const hasReacted =
      msgReactions &&
      msgReactions[emoji] &&
      msgReactions[emoji].includes(user.email);

    // Optimistic UI update
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id === msgId) {
          const reactions = m.reactions || { like: [], heart: [], thanks: [] };
          const updated = { ...reactions };
          if (hasReacted) {
            updated[emoji] = updated[emoji].filter(
              (e: string) => e !== user.email,
            );
          } else {
            updated[emoji] = [...(updated[emoji] || []), user.email];
          }
          return { ...m, reactions: updated };
        }
        return m;
      }),
    );
    setShowReactionPickerFor(null);

    try {
      const ref = doc(db, currentChatCollectionPath, msgId);
      await updateDoc(ref, {
        [`reactions.${emoji}`]: hasReacted
          ? arrayRemove(user.email)
          : arrayUnion(user.email),
      });
    } catch (e) {
      console.error("Failed to react", e);
      // State will be reverted automatically by onSnapshot if the write fails
    }
  };

  const renderMessageText = (text: string) => {
    if (!text) return null;
    const parts = text.split(/(@\S+)/g);
    return parts.map((part, i) => {
      if (part.startsWith("@")) {
        return (
          <span
            key={i}
            className="text-sky-600 dark:text-sky-400 font-bold bg-sky-100 dark:bg-sky-900/40 px-1 rounded mx-0.5 whitespace-nowrap"
          >
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  const getTypingText = () => {
    if (activeTypers.length === 0) return null;
    if (activeTypers.length === 1) {
      return isRtl
        ? `${activeTypers[0]} يكتب..`
        : `${activeTypers[0]} is typing..`;
    }
    if (activeTypers.length === 2) {
      return isRtl
        ? `${activeTypers[0]} و ${activeTypers[1]} يكتبون...`
        : `${activeTypers[0]} and ${activeTypers[1]} are typing...`;
    }
    return isRtl
      ? `${activeTypers[0]} و ${activeTypers.length - 1} آخرين يكتبون...`
      : `${activeTypers[0]} and ${activeTypers.length - 1} others are typing...`;
  };

  // Intersection Observer for auto-marking messages as viewed
  useEffect(() => {
    if (!user || !user.email) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const msgId = entry.target.getAttribute("data-message-id");
            const msgSender = entry.target.getAttribute("data-sender-id");

            if (msgId && msgSender && msgSender !== user.uid) {
              const msg = messages.find((m) => m.id === msgId);
              if (msg) {
                const viewersList = msg.reactions?.viewers || msg.viewers || [];
                if (!viewersList.includes(user.email!)) {
                  // Optimistic UI Update for viewing
                  setMessages((prev) =>
                    prev.map((m) => {
                      if (m.id === msgId) {
                        const newReactions = {
                          ...m.reactions,
                          like: m.reactions?.like || [],
                          heart: m.reactions?.heart || [],
                          thanks: m.reactions?.thanks || [],
                        };
                        newReactions.viewers = [
                          ...(m.reactions?.viewers || m.viewers || []),
                          user.email!,
                        ];
                        return { ...m, reactions: newReactions };
                      }
                      return m;
                    }),
                  );
                  // Update Firestore
                  updateDoc(doc(db, currentChatCollectionPath, msgId), {
                    "reactions.viewers": arrayUnion(user.email),
                  }).catch(() => {});
                }
              }
            }
          }
        });
      },
      { threshold: 0.5 },
    );

    const messageElements = document.querySelectorAll(
      ".message-bubble-container",
    );
    messageElements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [messages, user?.email, db]);

  return (
    <div
      className="flex z-30 max-w-7xl w-full mx-auto px-0"
      dir={isRtl ? "rtl" : "ltr"}
      style={{
        // Was `100dvh - 65px`, the height of the app header that used to sit
        // above it. That header is gone; what is left to subtract is the
        // status-bar inset App's root pads by, or the chat overflows by exactly
        // that much and the composer sits below the fold.
        height: "calc(100dvh - env(safe-area-inset-top))",
        paddingBottom: isMobileChatOpen ? "0px" : "calc(80px + env(safe-area-inset-bottom))",
      }}
    >
      {/* Sidebar - Chat List */}
      <div className={`flex flex-col ${isMobileChatOpen ? 'hidden md:flex' : 'flex w-full'} md:w-80 shrink-0 border-${isRtl ? 'l' : 'r'} border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-y-auto`}>
        {/* Telegram style filter tabs */}
        <div className="px-4 py-2 flex gap-2 overflow-x-auto no-scrollbar border-b border-slate-200 dark:border-zinc-800">
           <button onClick={() => setActiveChatFilter('all')} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${activeChatFilter === 'all' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700'}`}>
              {isRtl ? 'الكل' : 'All'}
           </button>
           {isAdminOrModerator && (
             <button onClick={() => setActiveChatFilter('personal')} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${activeChatFilter === 'personal' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700'}`}>
                {isRtl ? 'الخاص' : 'Personal'}
             </button>
           )}
        </div>
        
        <div className="flex flex-col w-full">
           {/* Group Chat Item */}
           {(activeChatFilter === 'all' || activeChatFilter === 'groups') && (
           <button
             onClick={() => { setActiveChat({ type: 'group', id: 'group', name: isRtl ? 'شات الدفعة' : 'Group Chat' }); setIsMobileChatOpen(true); }}
             className={`flex items-center gap-3 w-full h-[72px] px-4 transition-colors relative ${activeChat.type === 'group' ? 'bg-sky-100 dark:bg-sky-900/40' : 'hover:bg-slate-50 dark:hover:bg-zinc-800/80'}`}
           >
              <div className="w-12 h-12 shrink-0 rounded-full bg-sky-200 dark:bg-sky-900 flex items-center justify-center text-sky-700 dark:text-sky-300">
                 <Users className="w-6 h-6" />
              </div>
              <div className={`flex flex-col flex-1 h-full justify-center text-start border-b border-slate-100 dark:border-zinc-800 overflow-hidden ${activeChat.type === 'group' ? 'border-transparent dark:border-transparent' : ''}`}>
                 <div className="flex justify-between items-center mb-0.5 w-full">
                    <div className="font-bold text-[1rem] text-slate-800 dark:text-slate-200 truncate">{isRtl ? 'شات الدفعة' : 'Group Chat'}</div>
                 </div>
                 <div className="text-[0.9rem] text-slate-500 truncate">{isRtl ? 'الدردشة العامة' : 'General Chat'}</div>
              </div>
           </button>
           )}

           {/* Private Chats for Admins */}
           {isAdminOrModerator && (activeChatFilter === 'all' || activeChatFilter === 'personal') && inboxSessions.map(session => {
              const sessionUser = appUsers.find(u => u.email === session.studentEmail);
              const photoUrl = sessionUser?.hidePhotoOnLeaderboard ? undefined : sessionUser?.photoUrl;
              return (
                 <button
                    key={session.id}
                    onClick={() => { setActiveChat({ type: 'private', id: session.id, name: session.studentName, otherEmail: session.studentEmail }); setIsMobileChatOpen(true); }}
                    className={`flex items-center gap-3 w-full h-[72px] px-4 transition-colors relative ${activeChat.id === session.id ? 'bg-sky-100 dark:bg-sky-900/40' : 'hover:bg-slate-50 dark:hover:bg-zinc-800/80'}`}
                 >
                     <div className="w-12 h-12 shrink-0 rounded-full bg-slate-200 dark:bg-zinc-700 flex items-center justify-center font-bold text-slate-600 dark:text-slate-300 overflow-hidden">
                        {photoUrl ? <img src={photoUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : (session.studentName || '?').charAt(0).toUpperCase()}
                     </div>
                     <div className={`flex flex-col flex-1 h-full justify-center text-start border-b border-slate-100 dark:border-zinc-800 overflow-hidden ${activeChat.id === session.id ? 'border-transparent dark:border-transparent' : ''}`}>
                        <div className="flex justify-between items-center mb-0.5 w-full">
                           <div className="font-bold text-[1rem] text-slate-800 dark:text-slate-200 truncate">{session.studentName}</div>
                           <div className="text-xs text-slate-400">
                             {new Intl.DateTimeFormat(isRtl ? 'ar-IQ' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(new Date(session.updatedAt))}
                           </div>
                        </div>
                        <div className="text-[0.9rem] text-slate-500 truncate" dir="auto">{session.lastMessage}</div>
                     </div>
                 </button>
              );
           })}

           {/* Private Chats for Students */}
           {!isAdminOrModerator && (activeChatFilter === 'all' || activeChatFilter === 'personal') && (settings.privateAccounts || []).map(acc => {
              const chatId = [user?.email, acc.email].sort().join('_');
              const sessionUser = appUsers.find(u => u.email === acc.email);
              const photoUrl = sessionUser?.photoUrl;
              return (
                 <button
                    key={acc.id}
                    onClick={() => { setActiveChat({ type: 'private', id: chatId, name: acc.name, title: acc.title, otherEmail: acc.email }); setIsMobileChatOpen(true); }}
                    className={`flex items-center gap-3 w-full h-[72px] px-4 transition-colors relative ${activeChat.id === chatId ? 'bg-sky-100 dark:bg-sky-900/40' : 'hover:bg-slate-50 dark:hover:bg-zinc-800/80'}`}
                 >
                     <div className="w-12 h-12 shrink-0 rounded-full bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center text-sky-600 font-bold overflow-hidden">
                        {photoUrl ? <img src={photoUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" /> : acc.name.charAt(0).toUpperCase()}
                     </div>
                     <div className={`flex flex-col flex-1 h-full justify-center text-start border-b border-slate-100 dark:border-zinc-800 overflow-hidden ${activeChat.id === chatId ? 'border-transparent dark:border-transparent' : ''}`}>
                        <div className="flex justify-between items-center mb-0.5 w-full">
                           <div className="font-bold text-[1rem] text-slate-800 dark:text-slate-200 truncate">{acc.title}</div>
                        </div>
                        <div className="text-[0.9rem] text-slate-500 truncate">{acc.name}</div>
                     </div>
                 </button>
              );
           })}
        </div>
      </div>

      <div className={`flex flex-col relative w-full md:flex-1 h-full border-x border-slate-200 dark:border-zinc-800/50 bg-slate-50 dark:bg-zinc-950 overflow-hidden shadow-sm ${isMobileChatOpen ? 'flex' : 'hidden md:flex'}`}>
      {/* Header and Pinned Message */}
      <div className="flex-none z-40 flex flex-col shadow-sm">
        <div className="bg-white dark:bg-zinc-900 border-b border-slate-200 dark:border-zinc-800 p-2 sm:p-3 px-3 flex justify-between items-center h-[56px]">
          <div className="flex items-center gap-3 w-full overflow-hidden">
            <button className="md:hidden p-1 -ml-1 rtl:-ml-0 rtl:-mr-1 text-slate-500" onClick={() => setIsMobileChatOpen(false)}>
               <svg className={`w-6 h-6 ${isRtl ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
               </svg>
            </button>
            <div className="relative shrink-0">
              <div className="w-10 h-10 bg-sky-100 dark:bg-sky-900/40 rounded-full flex items-center justify-center text-sky-600 dark:text-sky-400 overflow-hidden shrink-0">
                {activeChat.type === 'group' ? (
                   <Users className="w-5 h-5" />
                ) : (
                   (() => {
                      const otherUser = appUsers.find(u => u.email === activeChat.otherEmail);
                      const photoUrl = isAdminOrModerator 
                            ? (otherUser?.hidePhotoOnLeaderboard ? undefined : otherUser?.photoUrl)
                            : otherUser?.photoUrl;
                      
                      return photoUrl ? (
                         <img src={photoUrl} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                         <span className="font-bold">{(activeChat.name || '?').charAt(0).toUpperCase()}</span>
                      );
                   })()
                )}
              </div>
              {settings.isChatOpen && activeChat.type === 'group' && (
                <span className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-white dark:border-zinc-900 rounded-full"></span>
              )}
              {!settings.isChatOpen && activeChat.type === 'group' && (
                <span className="absolute bottom-0 right-0 w-3 h-3 bg-red-500 border-2 border-white dark:border-zinc-900 rounded-full"></span>
              )}
            </div>
            <div>
              <h1 className="font-bold text-lg text-slate-800 dark:text-stone-100 leading-tight">
                {activeChat.name}
              </h1>
              {activeChat.type === 'group' ? (
                 <p className="text-xs text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1.5 flex-wrap">
                   <span>
                     {settings.isChatOpen
                       ? isRtl
                         ? "مفتوح"
                         : "Open"
                       : isRtl
                         ? "مغلق"
                         : "Closed"}
                   </span>
                   {totalUsersCount > 0 && (
                     <>
                       <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></span>
                       <span>
                         {totalUsersCount} {isRtl ? "طالب" : "students"}
                       </span>
                     </>
                   )}
                 </p>
              ) : (
                 <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                    {activeChat.title || (isRtl ? 'تواصل خاص' : 'Private Message')}
                 </p>
              )}
            </div>
          </div>

          {isAdminOrModerator && activeChat.type === 'group' && (
            <button
              onClick={() => setShowAdminControls(!showAdminControls)}
              className={`p-2 rounded-xl transition-colors ${showAdminControls ? "bg-sky-100 dark:bg-sky-900/50 text-sky-600" : "text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800"}`}
            >
              <Settings className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Pinned Message */}
        {settings.pinnedMessage && activeChat.type === 'group' && (
          <div
            className="bg-white/95 backdrop-blur dark:bg-zinc-900/95 border-b border-slate-200 dark:border-zinc-800 p-2 sm:px-4 cursor-pointer flex items-center gap-2"
            onClick={() => handleViewPinnedMessage(settings.pinnedMessage!.id)}
          >
            <div className="w-8 h-8 rounded-full bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center shrink-0">
              📌
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="text-xs font-bold text-sky-600 dark:text-sky-400">
                {isRtl ? "رسالة مثبتة" : "Pinned Message"}
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-300 truncate">
                {settings.pinnedMessage.text}
              </div>
            </div>
            {isAdminOrModerator && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  updateDoc(doc(db, "chat_settings", CHAT_DOC_ID), {
                    pinnedMessage: null,
                  });
                }}
                className="p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-400 transition-colors"
                title={isRtl ? "إلغاء التثبيت" : "Unpin"}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Admin Panel */}
      <AnimatePresence>
        {isAdminOrModerator && showAdminControls && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-y-auto max-h-[40vh] border-b border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-900/50 shadow-inner z-20"
          >
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  الشات مفتوح / مغلق
                </span>
                <button
                  onClick={toggleChatStatus}
                  className={`w-14 h-7 rounded-full transition-colors relative flex items-center px-1 ${settings.isChatOpen ? "bg-sky-500" : "bg-slate-300 dark:bg-zinc-700"}`}
                >
                  <div
                    className={`w-5 h-5 bg-white rounded-full absolute shadow-sm transition-all transform ${settings.isChatOpen ? (isRtl ? "-translate-x-7" : "translate-x-7") : "translate-x-0"}`}
                  />
                </button>
              </div>

              {/* Message Cooldown setting was removed here */}

              <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-zinc-800">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  {isRtl
                    ? "السماح للطلاب بإرسال مرفقات"
                    : "Allow Students to Send Attachments"}
                </span>
                <button
                  onClick={async () => {
                    const newVal = !(settings.allowAttachments ?? true);
                    setSettings({ ...settings, allowAttachments: newVal });
                    await updateDoc(doc(db, "chat_settings", CHAT_DOC_ID), {
                      allowAttachments: newVal,
                    });
                  }}
                  className={`w-14 h-7 rounded-full transition-colors relative flex items-center px-1 ${settings.allowAttachments !== false ? "bg-sky-500" : "bg-slate-300 dark:bg-zinc-700"}`}
                >
                  <div
                    className={`w-5 h-5 bg-white rounded-full absolute shadow-sm transition-all transform ${settings.allowAttachments !== false ? (isRtl ? "-translate-x-7" : "translate-x-7") : "translate-x-0"}`}
                  />
                </button>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-zinc-800 flex flex-wrap justify-between gap-2">
                <button
                  onClick={() => setShowAccountsManage(!showAccountsManage)}
                  className="flex items-center gap-1.5 px-3 py-2 bg-sky-50 text-sky-600 dark:bg-sky-900/20 dark:text-sky-400 rounded-xl text-xs font-bold hover:bg-sky-100 dark:hover:bg-sky-900/40"
                >
                  <Users className="w-4 h-4" />
                  {isRtl ? "إدارة حسابات التواصل" : "Manage Contact Accounts"}
                </button>

                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="flex items-center gap-1.5 px-3 py-2 bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400 rounded-xl text-xs font-bold hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  <Trash2 className="w-4 h-4" />
                  {isRtl ? "مسح كل الرسائل" : "Clear All"}
                </button>
              </div>
              
              {/* Manage Accounts Panel */}
              {showAccountsManage && (
                <div className="pt-3 border-t border-slate-200 dark:border-zinc-800">
                  <div className="mb-4 space-y-2">
                    {(settings.privateAccounts || []).map((acc, idx) => (
                      <div key={acc.id || `acc-${idx}`} className="flex flex-col sm:flex-row gap-2 items-start sm:items-center bg-white dark:bg-zinc-800 p-3 rounded-lg border border-slate-100 dark:border-zinc-700">
                        <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div className="text-xs font-bold text-sky-600">{acc.title}</div>
                          <div className="text-sm font-medium text-slate-700 dark:text-slate-300">{acc.name}</div>
                          <div className="text-xs text-slate-500 truncate" title={acc.email}>{acc.email}</div>
                        </div>
                        <button
                          onClick={async () => {
                            const updated = settings.privateAccounts!.filter(a => a.id !== acc.id);
                            setSettings({ ...settings, privateAccounts: updated });
                            await updateDoc(doc(db, "chat_settings", CHAT_DOC_ID), {
                              privateAccounts: updated
                            });
                          }}
                          className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  
                  <div className="bg-slate-100 dark:bg-zinc-800/50 p-3 rounded-xl border border-slate-200 dark:border-zinc-700 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder={isRtl ? "المسمى (مثال: حساب الممثل)" : "Title"}
                      value={newAccount.title || ""}
                      onChange={(e) => setNewAccount({ ...newAccount, title: e.target.value })}
                      className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm sm:col-span-2"
                    />
                    <select
                      value={newAccount.email || ""}
                      onChange={(e) => {
                         const u = appUsers.find(user => user.email === e.target.value);
                         if (u) {
                            setNewAccount({ ...newAccount, email: u.email, name: u.name });
                         } else {
                            setNewAccount({ ...newAccount, email: "", name: "" });
                         }
                      }}
                      className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm sm:col-span-2 mt-1"
                    >
                      <option value="">{isRtl ? "اختر الحساب..." : "Select Account..."}</option>
                      {appUsers.map(u => (
                         <option key={u.id} value={u.email}>{u.name} ({u.email})</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        if (newAccount.title && newAccount.name && newAccount.email) {
                          const acc = { ...newAccount, id: Date.now().toString() } as PrivateAccount;
                          const updated = [...(settings.privateAccounts || []), acc];
                          setSettings({ ...settings, privateAccounts: updated });
                          await updateDoc(doc(db, "chat_settings", CHAT_DOC_ID), {
                            privateAccounts: updated
                          });
                          setNewAccount({});
                        }
                      }}
                      className="sm:col-span-2 py-2 bg-sky-600 text-white font-bold rounded-lg hover:bg-sky-700 transition"
                    >
                      {isRtl ? "إضافة حساب" : "Add Account"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages Area */}
      <div
        ref={containerRef}
        onScroll={(e) => {
          // With flex-col-reverse, scrollTop = 0 is bottom. For cross browser, use absolute value
          const { Math } = window;
          const atBottom = Math.abs(e.currentTarget.scrollTop) < 50;
          setIsAtBottom(atBottom);
          if (atBottom) {
            setUnreadCount(0);
          }
        }}
        className="flex-1 overflow-y-auto p-4 flex flex-col-reverse bg-slate-50 dark:bg-zinc-950 scroll-smooth overscroll-contain gap-4"
      >
        <div ref={messagesEndRef} className="h-px shrink-0" />
        
        {isLoading ? (
          <div className="h-full flex items-center justify-center">
            <RefreshCw className="w-6 h-6 text-sky-600 dark:text-sky-400 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600 space-y-3">
            <MessageSquare className="w-12 h-12 opacity-50" />
            <p className="font-medium">
              {isRtl ? "لا توجد رسائل بعد" : "No messages yet"}
            </p>
          </div>
        ) : (
          filterBlocked([...messages].reverse(), user?.blockedUsers).map((msg, idx, arr) => {
            const isMe = getIsMe(msg);
            const msgDate = new Date(msg.createdAt);

            // Format time logic
            const formatChatTime = (timestamp: number) => {
              const date = new Date(timestamp);
              return date.toLocaleTimeString(isRtl ? "ar-IQ" : "en-US", {
                timeZone: "Asia/Baghdad",
                hour: "2-digit",
                minute: "2-digit",
              });
            };
            const timeStr = formatChatTime(msg.createdAt);
            
            // Since array is reversed (newest first), the "previous" message in chronological order is at idx + 1
            const prevMsgChrono = idx + 1 < arr.length ? arr[idx + 1] : null;

            const isDifferentDay =
              !prevMsgChrono ||
              new Date(prevMsgChrono.createdAt).toLocaleDateString("en-US", {
                timeZone: "Asia/Baghdad",
              }) !==
                new Date(msg.createdAt).toLocaleDateString("en-US", {
                  timeZone: "Asia/Baghdad",
                });

            const diffMinsHeader = prevMsgChrono
              ? (msg.createdAt - prevMsgChrono.createdAt) / 60000
              : 999;
            const isAnonGroupChange = prevMsgChrono
              ? !!prevMsgChrono.isAnonymous !== !!msg.isAnonymous
              : false;
            const showHeader =
              (!isMe || msg.isAnonymous) &&
              (!prevMsgChrono ||
                prevMsgChrono.senderEmail !== msg.senderEmail ||
                diffMinsHeader > 5 ||
                isAnonGroupChange);

            return (
              <React.Fragment key={msg.id}>
                <MessageBubble
                  msg={msg}
                  isMe={isMe}
                  showHeader={showHeader}
                  timeStr={timeStr}
                  isRtl={isRtl}
                  user={user}
                  isMasterAdmin={isMasterAdmin}
                  isAdminOrModerator={isAdminOrModerator}
                  revealedMessages={revealedMessages}
                  showReactionPickerFor={showReactionPickerFor}
                  setShowReactionPickerFor={setShowReactionPickerFor}
                  handleReaction={handleReaction}
                  setReplyingTo={setReplyingTo}
                  setMessageToDelete={setMessageToDelete}
                  setRevealedMessages={setRevealedMessages}
                  setCurrentTab={setCurrentTab}
                  CHAT_DOC_ID={CHAT_DOC_ID}
                  renderMessageText={renderMessageText}
                  appUsers={appUsers}
                  onReportMessage={(m: any) => setReportTarget({
                    messageId: m.id,
                    messageText: m.text || '',
                    senderId: m.senderId ?? null,
                    senderName: m.isAnonymous ? null : (m.senderName ?? null),
                    chatPath: currentChatCollectionPath,
                  })}
                />
                
                {isDifferentDay && (
                  <div className="flex justify-center my-4 pb-2">
                    <span className="px-3 py-1 bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-slate-400 text-xs font-bold rounded-full">
                      {new Intl.DateTimeFormat(isRtl ? "ar-IQ" : "en-US", {
                        timeZone: "Asia/Baghdad",
                        month: "short",
                        day: "numeric",
                        weekday: "short",
                      }).format(msgDate)}
                    </span>
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}

        {hasMore && !isLoading && (
          <div className="flex justify-center mt-4">
            <button
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="px-4 py-2 bg-white dark:bg-zinc-800 rounded-full border border-slate-200 dark:border-zinc-700 text-xs font-bold text-slate-600 dark:text-slate-400 shadow-sm hover:shadow-md transition-all disabled:opacity-50 flex items-center justify-center min-w-[120px]"
            >
              {isLoadingMore ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : isRtl ? (
                "تحميل المزيد"
              ) : (
                "Load Older"
              )}
            </button>
          </div>
        )}
      </div>

      <AnimatePresence>
        {!isAtBottom && unreadCount > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            onClick={() => {
              scrollToBottom();
              setUnreadCount(0);
            }}
            className="absolute bottom-[90px] sm:bottom-[100px] right-4 bg-sky-600 text-white rounded-full p-2.5 shadow-lg flex items-center justify-center gap-1.5 z-40 hover:bg-sky-500 transition-colors"
          >
            <div className="flex items-center gap-1 px-1 text-sm font-bold">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 14l-7 7m0 0l-7-7m7 7V3"
                />
              </svg>
              {unreadCount} {isRtl ? "رسالة جديدة" : "New"}
            </div>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div className="flex-none p-2 sm:p-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] bg-slate-50 dark:bg-zinc-950 border-t border-slate-200/50 dark:border-zinc-800/50 relative z-40">
        <div className="pointer-events-auto w-full mx-auto max-w-3xl">
          {!settings.isChatOpen && !isAdminOrModerator ? (
            <div className="bg-slate-100 dark:bg-zinc-800 rounded-xl p-3 flex items-center justify-center gap-2 text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-zinc-700 border-dashed">
              <StopCircle className="w-5 h-5" />
              <span className="font-medium text-sm">
                {settings.closedMessage ||
                  "الشات مغلق حالياً — يمكنك القراءة فقط"}
              </span>
            </div>
          ) : (
            <div className="relative">
              {/* Absolute popovers */}
              <div className="absolute bottom-full left-0 right-0 mb-2 mx-2 flex flex-col gap-2 z-50 pointer-events-none">
                {/* Mentions */}
                {mentionSearch !== null && mentionFiltered.length > 0 && (
                  <div className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-lg overflow-hidden pointer-events-auto">
                    {mentionFiltered.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => {
                          const newMsg = newMessage.replace(
                            /@([^\s]*)$/,
                            `@${u.name.replace(/\s+/g, "_")} `,
                          );
                          setNewMessage(newMsg);
                          setMentionSearch(null);
                        }}
                        className="w-full flex items-center gap-3 p-3 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors border-b border-slate-100 dark:border-zinc-700/50 last:border-0"
                      >
                        <div className="w-8 h-8 bg-sky-100 dark:bg-sky-900 overflow-hidden font-bold text-sky-600 dark:text-sky-400 rounded-full flex items-center justify-center shrink-0">
                          {u.photoUrl && !u.hidePhoto ? (
                            <img
                              src={u.photoUrl}
                              alt={u.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            u.name?.charAt(0) || "?"
                          )}
                        </div>
                        <span className="font-medium text-sm text-slate-700 dark:text-slate-200">
                          {u.name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {replyingTo && (
                  <div className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl p-3 shadow-lg flex items-start gap-2 pointer-events-auto">
                    <div className="flex-1 overflow-hidden">
                      <div className="text-xs font-bold text-sky-600 dark:text-sky-400 mb-0.5">
                        ↩ {isRtl ? "رد على" : "Replying to"}{" "}
                        {replyingTo.senderName}
                      </div>
                      <div
                        className="text-sm text-slate-500 dark:text-slate-400 truncate"
                        dir="auto"
                      >
                        {replyingTo.text}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyingTo(null)}
                      className="p-1 rounded-full bg-slate-100 dark:bg-zinc-700 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* Attachment Preview */}
                {(attachmentFile || embeddedItem) && (
                  <div className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl p-3 shadow-lg flex items-center justify-between pointer-events-auto">
                    <div className="flex items-center gap-3 overflow-hidden">
                      {attachmentType === "image" && attachmentFile ? (
                        <img
                          src={URL.createObjectURL(attachmentFile)}
                          alt="Preview"
                          className="w-10 h-10 rounded object-cover"
                        />
                      ) : embeddedItem ? (
                        <div className="flex items-center gap-2 p-1.5 bg-sky-50 dark:bg-sky-900/30 rounded border border-sky-100 dark:border-sky-800">
                          <Link className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">
                              {embeddedItem.title}
                            </span>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 capitalize">
                              {embeddedItem.type}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="p-2 bg-slate-50 dark:bg-zinc-800/50 rounded border border-slate-100 dark:border-zinc-700">
                          <Paperclip className="w-5 h-5 text-sky-600" />
                        </div>
                      )}
                      <div className="flex flex-col overflow-hidden">
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                          {attachmentFile
                            ? attachmentFile.name
                            : embeddedItem?.title}
                        </span>
                        <span className="text-xs text-slate-500">
                          {attachmentFile
                            ? `${(attachmentFile.size / 1024 / 1024).toFixed(2)} MB`
                            : "Embedded Media"}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setAttachmentFile(null);
                        setEmbeddedItem(null);
                        setAttachmentType(null);
                      }}
                      className="p-1.5 rounded-full bg-slate-100 dark:bg-zinc-700 hover:bg-red-100 text-slate-500 hover:text-red-600 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {/* Typing Indicator */}
                {activeTypers.length > 0 && (
                  <div className="flex items-center gap-2 px-3 py-1.5 pointer-events-auto">
                    <div className="flex gap-0.5 items-center justify-center p-1.5 px-2 bg-slate-200 dark:bg-zinc-700/80 rounded-2xl w-fit shadow-sm">
                      <motion.div
                        className="w-1 h-1 bg-slate-500 dark:bg-slate-300 rounded-full"
                        animate={{ y: [0, -3, 0] }}
                        transition={{
                          repeat: Infinity,
                          duration: 1,
                          ease: "easeInOut",
                          delay: 0,
                        }}
                      />
                      <motion.div
                        className="w-1 h-1 bg-slate-500 dark:bg-slate-300 rounded-full"
                        animate={{ y: [0, -3, 0] }}
                        transition={{
                          repeat: Infinity,
                          duration: 1,
                          ease: "easeInOut",
                          delay: 0.2,
                        }}
                      />
                      <motion.div
                        className="w-1 h-1 bg-slate-500 dark:bg-slate-300 rounded-full"
                        animate={{ y: [0, -3, 0] }}
                        transition={{
                          repeat: Infinity,
                          duration: 1,
                          ease: "easeInOut",
                          delay: 0.4,
                        }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                      {getTypingText()}
                    </span>
                  </div>
                )}
              </div>

              {/* Attachment Menu Popup */}
              <AnimatePresence>
                {showAttachmentMenu && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className={`absolute bottom-[60px] z-50 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl border border-slate-200 dark:border-zinc-700 p-2 flex flex-col gap-1 w-48 ${isRtl ? "right-2" : "left-2"}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        fileInputRef.current?.setAttribute("accept", "image/*");
                        fileInputRef.current?.click();
                        setShowAttachmentMenu(false);
                      }}
                      className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-zinc-700/50 transition-colors text-slate-700 dark:text-slate-200 text-sm font-medium w-full text-left rtl:text-right"
                    >
                      <ImageIcon className="w-4 h-4 text-sky-500" />
                      {isRtl ? "صورة" : "Image"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        fileInputRef.current?.setAttribute("accept", "*/*");
                        fileInputRef.current?.click();
                        setShowAttachmentMenu(false);
                      }}
                      className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-zinc-700/50 transition-colors text-slate-700 dark:text-slate-200 text-sm font-medium w-full text-left rtl:text-right"
                    >
                      <FileText className="w-4 h-4 text-indigo-500" />
                      {isRtl ? "ملف" : "File"}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setAttachmentFile(file);
                    setAttachmentType(
                      file.type.startsWith("image/") ? "image" : "file",
                    );
                  }
                }}
              />

              {/* Telegram-style fixed input bar. LTR -> input then send. RTL -> send then input */}
              <div className="flex-none z-40">
                <form
                  onSubmit={handleSendMessage}
                  className="flex items-end gap-1 sm:gap-2 relative bg-white dark:bg-zinc-900 rounded-[24px] p-1 shadow-sm border border-slate-200 dark:border-zinc-800 min-h-[48px]"
                  dir={isRtl ? "rtl" : "ltr"}
                >
                  <div className="flex items-center shrink-0 h-[40px]">
                    {!isAdminOrModerator && (
                      <button
                        type="button"
                        title={isRtl ? "إرسال كمجهول" : "Send Anonymous"}
                        onClick={() => setIsAnonymous(!isAnonymous)}
                        className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${isAnonymous ? "text-amber-500" : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"}`}
                      >
                        <svg
                          className="w-5 h-5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                          <line
                            x1="2"
                            x2="22"
                            y1="2"
                            y2="22"
                            stroke={isAnonymous ? "currentColor" : "transparent"}
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                  <textarea
                    ref={textareaRef}
                    value={newMessage}
                    onChange={(e) => {
                      setNewMessage(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height =
                        Math.min(e.target.scrollHeight, 120) + "px";
                    }}
                    maxLength={1000}
                    placeholder={isRtl ? "رسالة..." : "Message..."}
                    className="flex-1 bg-transparent border-transparent py-[10px] px-2 min-h-[40px] max-h-32 outline-none resize-none text-[0.95rem] text-slate-900 dark:text-stone-100 placeholder:text-slate-400 block"
                    dir="auto"
                    rows={1}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage(e);
                      }
                    }}
                  />
                  <div className="flex items-center shrink-0 h-[40px]">
                    {(isAdminOrModerator ||
                      settings.allowAttachments !== false) && (
                      <button
                        type="button"
                        onClick={() => setShowAttachmentMenu(!showAttachmentMenu)}
                        className="w-10 h-10 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex items-center justify-center transition-colors shrink-0"
                      >
                        <Paperclip className="w-[1.2rem] h-[1.2rem]" />
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={
                        isSending ||
                        (!newMessage.trim() && !attachmentFile && !embeddedItem) ||
                        (!settings.isChatOpen && !isAdminOrModerator)
                      }
                      className="w-10 h-10 text-sky-500 hover:text-sky-600 dark:hover:text-sky-400 flex items-center justify-center disabled:opacity-50 transition-colors shrink-0"
                    >
                      {isSending ? (
                        <RefreshCw className="w-5 h-5 animate-spin" />
                      ) : (
                        <Send
                          className={`w-[1.3rem] h-[1.3rem] ${isRtl ? "rotate-180 transform -ml-1" : "ml-1"}`}
                        />
                      )}
                    </button>
                  </div>
                </form>
                {/* Character limit counter */}
                {newMessage.length > 800 && (
                  <div className="absolute -top-4 right-4 text-[10px] text-slate-500 font-bold">
                    {newMessage.length} / 1000
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Clear All Confirm Modal */}
      <AnimatePresence>
        <ReportMessageSheet
          lang={lang}
          target={reportTarget}
          onClose={() => setReportTarget(null)}
        />

        {messageToDelete && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMessageToDelete(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-sm bg-white dark:bg-zinc-800 rounded-3xl shadow-2xl overflow-hidden p-6 border border-slate-200 dark:border-zinc-700"
            >
              <h3 className="text-xl font-bold text-slate-900 dark:text-stone-100 mb-2">
                {isRtl ? "حذف الرسالة" : "Delete Message"}
              </h3>
              <p className="text-slate-500 dark:text-slate-400 mb-6 font-medium">
                {isRtl
                  ? "هل أنت متأكد من حذف هذه الرسالة؟"
                  : "Are you sure you want to delete this message?"}
              </p>

              <div className="flex gap-3">
                <button
                  onClick={() => setMessageToDelete(null)}
                  className="flex-1 py-3 px-4 rounded-xl font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-zinc-700/50 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                >
                  {isRtl ? "إلغاء" : "Cancel"}
                </button>
                <button
                  onClick={() => {
                    deleteMessage(messageToDelete);
                    setMessageToDelete(null);
                  }}
                  className="flex-1 py-3 px-4 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 transition-colors flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-5 h-5" />
                  {isRtl ? "حذف" : "Delete"}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showClearConfirm && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowClearConfirm(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-white dark:bg-zinc-800 rounded-3xl shadow-2xl overflow-hidden p-6 border border-slate-200 dark:border-zinc-700"
            >
              <h3 className="text-xl font-bold text-slate-900 dark:text-stone-100 mb-2">
                {isRtl ? "مسح جميع الرسائل" : "Clear All Messages"}
              </h3>
              <p className="text-slate-500 dark:text-slate-400 mb-6 font-medium">
                {isRtl
                  ? "هل أنت متأكد من مسح جميع الرسائل بشكل نهائي؟ لا يمكن التراجع عن هذا الإجراء."
                  : "Are you sure you want to permanently delete all messages? This action cannot be undone."}
              </p>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="flex-1 py-3 px-4 rounded-xl font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-zinc-700/50 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                >
                  {isRtl ? "إلغاء" : "Cancel"}
                </button>
                <button
                  onClick={clearAllMessages}
                  disabled={isClearing}
                  className="flex-1 py-3 px-4 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isClearing ? (
                    <RefreshCw className="w-5 h-5 animate-spin" />
                  ) : (
                    <Trash2 className="w-5 h-5" />
                  )}
                  {isRtl ? "تأكيد الحذف" : "Confirm Delete"}
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {alertMessage && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setAlertMessage(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-sm bg-white dark:bg-zinc-800 rounded-3xl shadow-2xl overflow-hidden p-6 text-center border border-slate-200 dark:border-zinc-700"
            >
              <p className="text-slate-800 dark:text-slate-200 font-medium mb-6">
                {alertMessage}
              </p>
              <button
                onClick={() => setAlertMessage(null)}
                className="w-full py-3 px-4 rounded-xl font-bold text-white bg-sky-600 hover:bg-sky-700 transition-colors"
              >
                {isRtl ? "حسناً" : "OK"}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
