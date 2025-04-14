import NoteState from 'libs/web/state/note';
import { useRouter } from 'next/router';
import {
    useCallback,
    MouseEvent as ReactMouseEvent,
    useState,
    useRef,
    useEffect, 
} from 'react';
import { searchNote, searchRangeText } from 'libs/web/utils/search';
import useFetcher from 'libs/web/api/fetcher';
import { NOTE_DELETED } from 'libs/shared/meta';
import { isNoteLink, NoteModel } from 'libs/shared/note';
import { useToast } from 'libs/web/hooks/use-toast';
import PortalState from 'libs/web/state/portal';
import { NoteCacheItem } from 'libs/web/cache';
import noteCache from 'libs/web/cache/note';
import { createContainer } from 'unstated-next';
import MarkdownEditor from '@notea/rich-markdown-editor';
import { useDebouncedCallback } from 'use-debounce';
import { ROOT_ID } from 'libs/shared/tree';
import { has } from 'lodash';
import UIState from './ui';

const onSearchLink = async (keyword: string) => {
    const list = await searchNote(keyword, NOTE_DELETED.NORMAL);

    return list.map((item) => ({
        title: item.title,
        // todo 路径
        subtitle: searchRangeText({
            text: item.rawContent || '',
            keyword,
            maxLen: 40,
        }).match,
        url: `/${item.id}`,
    }));
};

const useEditor = (initNote?: NoteModel) => {
    const {
        createNoteWithTitle,
        updateNote,
        createNote,
        note: noteProp,
    } = NoteState.useContainer();
    const note = initNote ?? noteProp;
    const {
        ua: { isBrowser },
    } = UIState.useContainer();
    const router = useRouter();
    const { request, error } = useFetcher();
    const toast = useToast();
    const editorEl = useRef<MarkdownEditor>(null);

    const onNoteChange = useDebouncedCallback(
        async (data: Partial<NoteModel>) => {
            const isNew = has(router.query, 'new');

            if (isNew) {
                data.pid = (router.query.pid as string) || ROOT_ID;
                const item = await createNote({ ...note, ...data });
                const noteUrl = `/${item?.id}`;

                if (router.asPath !== noteUrl) {
                    await router.replace(noteUrl, undefined, { shallow: true });
                }
            } else {
                await updateNote(data);
            }
        },
        500
    );

    const onCreateLink = useCallback(
        async (title: string) => {
            const result = await createNoteWithTitle(title);

            if (!result) {
                throw new Error('todo');
            }

            return `/${result.id}`;
        },
        [createNoteWithTitle]
    );

    const onClickLink = useCallback(
        (href: string) => {
            if (isNoteLink(href.replace(location.origin, ''))) {
                router.push(href, undefined, { shallow: true })
                    .catch((v) => console.error('Error whilst pushing href to router: %O', v));
            } else {
                window.open(href, '_blank');
            }
        },
        [router]
    );

    const onUploadImage = useCallback(
        async (file: File, id?: string) => {
            const data = new FormData();
            data.append('file', file);
            const result = await request<FormData, { url: string }>(
                {
                    method: 'POST',
                    url: `/api/upload?id=${id}`,
                },
                data
            );
            if (!result) {
                toast(error, 'error');
                throw Error(error);
            }
            return result.url;
        },
        [error, request, toast]
    );

    const { preview, linkToolbar } = PortalState.useContainer();

    const onHoverLink = useCallback(
        (event: MouseEvent | ReactMouseEvent) => {
            if (!isBrowser || editorEl.current?.props.readOnly) {
                return true;
            }
            const link = event.target as HTMLLinkElement;
            const href = link.getAttribute('href');
            if (link.classList.contains('bookmark')) {
                return true;
            }
            if (href) {
                if (isNoteLink(href)) {
                    preview.close();
                    preview.setData({ id: href.slice(1) });
                    preview.setAnchor(link);
                } else {
                    linkToolbar.setData({ href, view: editorEl.current?.view });
                    linkToolbar.setAnchor(link);
                }
            } else {
                preview.setData({ id: undefined });
            }
            return true;
        },
        [isBrowser, preview, linkToolbar]
    );

    const [backlinks, setBackLinks] = useState<NoteCacheItem[]>();

    const getBackLinks = useCallback(async () => {
        console.log(note?.id);
        const linkNotes: NoteCacheItem[] = [];
        if (!note?.id) return linkNotes;
        setBackLinks([]);
        await noteCache.iterate<NoteCacheItem, void>((value) => {
            if (value.linkIds?.includes(note.id)) {
                linkNotes.push(value);
            }
        });
        setBackLinks(linkNotes);
    }, [note?.id]);

    const onEditorChange = useCallback(
        (value: () => string): void => {
            try {
                // 只有在编辑模式下才更新内容
                if (isEditing) {
                    console.log('保存内容:', value().substring(0, 50) + '...');
                    
                    onNoteChange.callback({ content: value() })
                        .catch((err) => {
                            console.error('保存笔记时出错:', err);
                            toast('保存失败，请重试', 'error');
                        });
                }
            } catch (err) {
                console.error('处理编辑器内容变更时出错:', err);
                toast('处理内容变更失败', 'error');
            }
        },
        [onNoteChange, isEditing, toast]
    );

    // 添加初始内容加载
    useEffect(() => {
        if (note?.content) {
            setCurrentContent(note.content);
        }
    }, [note?.content]);


    useEffect(() => {
        // 检查是否为新建笔记
        const isNew = has(router.query, 'new');
        if (isNew) {
            // 如果是新建笔记，自动设置为编辑状态
            setIsEditing(true);
        }
    }, [router.query]);
    
    // 添加未保存内容提示
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (isEditing && currentContent !== note?.content) {
                const message = '您有未保存的更改，确定要离开吗？';
                e.returnValue = message;
                return message;
            }
        };
    
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [isEditing, currentContent, note?.content]);

    const saveNote = useCallback(
        async () => {
            if (currentContent) {
                try {
                    await onNoteChange.callback({ content: currentContent });
                    toast('笔记已保存', 'success');
                    setIsEditing(false);
                } catch (error) {
                    console.error('Error whilst updating note: %O', error);
                    toast('保存失败，请重试', 'error');
                }
            }
        },
        [currentContent, onNoteChange, toast]
    );

    const toggleEditMode = useCallback(() => {
        setIsEditing((prev) => !prev);
    }, []);

    return {
        onCreateLink,
        onSearchLink,
        onClickLink,
        onUploadImage,
        onHoverLink,
        getBackLinks,
        onEditorChange,
        onNoteChange,
        backlinks,
        editorEl,
        note,
        saveNote,
        toggleEditMode,
        isEditing,
        setIsEditing,
        currentContent    
    };
};

const EditorState = createContainer(useEditor);

declare module 'unstated-next' {
    interface ContainerType<State, Initializers extends unknown[]> {
        Provider: React.FC<{
            initialState?: Initializers[0];
            children: React.ReactNode;
        }>;
        useContainer: () => State;
    }
}

export default EditorState;
