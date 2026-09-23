import React,{memo} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import './markdown-message.css';

const remarkPlugins=[remarkGfm];
const rehypePlugins=[[rehypeHighlight,{detect:false,ignoreMissing:true}]];
const components={
  table:({children})=><div className="markdown-table" role="region" aria-label="消息表格" tabIndex={0}><table>{children}</table></div>,
  a:({href,children,title})=><a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
};

export default memo(function MarkdownMessage({text}){
  return <div className="markdown-message"><Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{text??''}</Markdown></div>;
});
