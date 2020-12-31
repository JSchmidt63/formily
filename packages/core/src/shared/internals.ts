import {
  FormPath,
  FormPathPattern,
  each,
  reduce,
  pascalCase,
  isHTMLElement,
  isFn,
  isValid,
} from '@formily/shared'
import { ValidatorTriggerType, validate } from '@formily/validator'
import { action, runInAction, toJS } from 'mobx'
import { Field, ArrayField, Form } from '../models'
import {
  ISpliceArrayStateProps,
  IExchangeArrayStateProps,
  ISearchFeedback,
  Feedback,
  INodePatch,
  GeneralField,
  FormFeedback,
  LifeCycleTypes,
} from '../types'
import { isArrayField, isVoidField } from './externals'
import { ReservedProperties, GetterSetterProperties } from './constants'

export const getValueFromEvent = (event: any) => {
  if (isHTMLElement(event?.target)) {
    return event.target.value
  }
  return event
}

export const buildFieldPath = (field: GeneralField) => {
  let prevArray = false
  return field.address.reduce((path: FormPath, key: string, index: number) => {
    const currentPath = path.concat([key])
    const currentAddress = field.address.slice(0, index + 1)
    const current = field.form.fields[currentAddress.toString()]
    if (index >= field.address.length - 1) {
      if (isVoidField(field)) {
        return currentPath
      }
      if (prevArray) return path
      return currentPath
    }
    if (isVoidField(current)) {
      if (isArrayField(current.parent)) {
        prevArray = true
        return currentPath
      }
      return path
    } else {
      prevArray = false
    }
    return currentPath
  }, new FormPath(''))
}

export const buildNodeIndexes = (
  field: GeneralField,
  address: FormPathPattern
) => {
  field.address = FormPath.parse(address)
  field.path = buildFieldPath(field)
  field.form.indexes.set(field.path.toString(), field.address.toString())
  return field
}

export const applyFieldPatches = (
  target: Record<string, GeneralField>,
  patches: INodePatch<GeneralField>[]
) => {
  patches.forEach(({ type, address, payload }) => {
    if (type === 'remove') {
      delete target[address]
    } else if (type === 'update') {
      if (payload) {
        target[address] = payload
      }
    }
  })
}

export const matchFeedback = (
  search: ISearchFeedback,
  feedback: FormFeedback
) => {
  if (!search || !feedback) return false
  if (search.type && search.type !== feedback.type) return false
  if (search.code && search.code !== feedback.code) return false
  if (search.path && feedback.path) {
    if (!FormPath.parse(search.path).match(feedback.path)) return false
  }
  if (search.address && feedback.address) {
    if (!FormPath.parse(search.address).match(feedback.address)) return false
  }
  if (search.triggerType && search.triggerType !== feedback.triggerType)
    return false
  return true
}

export const queryFeedbacks = (field: Field, search: ISearchFeedback) => {
  return field.feedbacks.filter((feedback) => {
    return matchFeedback(search, {
      ...feedback,
      address: field.address,
      path: field.path,
    })
  })
}

export const queryFeedbackMessages = (
  field: Field,
  search: ISearchFeedback
) => {
  return queryFeedbacks(field, search).reduce(
    (buf, info) => buf.concat(info.messages),
    []
  )
}

export const updateFeedback = (field: Field, feedback: Feedback) => {
  return runInAction(() => {
    if (!field.feedbacks?.length) {
      if (!feedback?.messages?.length) {
        return
      }
      field.feedbacks = [feedback]
    } else {
      const searched = queryFeedbacks(field, feedback)
      if (searched?.length) {
        field.feedbacks = field.feedbacks?.reduce((buf, item) => {
          if (searched.includes(item)) {
            if (feedback?.messages?.length) {
              item.messages = feedback.messages
              return buf.concat(item)
            } else {
              return buf
            }
          } else {
            return buf.concat(item)
          }
        }, [])
        return
      }
      field.feedbacks = field.feedbacks?.concat(feedback)
    }
  })
}

export const validateToFeedbacks = async (
  field: Field,
  triggerType?: ValidatorTriggerType
) => {
  const results = await validate(field.value, field.validator, {
    triggerType,
    validateFirst:
      field.props?.validateFirst || field.form?.props?.validateFirst,
    context: this,
  })
  const shouldSkipValidate =
    field.display !== 'visible' || field.pattern !== 'editable'
  runInAction(() => {
    each(results, (messages, type) => {
      field.setFeedback({
        triggerType,
        type,
        code: pascalCase(`validate-${type}`),
        messages: shouldSkipValidate ? [] : messages,
      } as any)
    })
  })
  return results
}

export const spliceArrayState = (
  field: ArrayField,
  props?: ISpliceArrayStateProps
) => {
  const { startIndex, deleteCount, insertCount } = {
    startIndex: 0,
    deleteCount: 0,
    insertCount: 0,
    ...props,
  }
  const address = field.address.toString()
  const fields = field.form.fields
  const fieldPatches: INodePatch<GeneralField>[] = []
  const offset = insertCount - deleteCount
  const isArrayChildren = (identifier: string) => {
    return (
      identifier.indexOf(address) === 0 && identifier.length > address.length
    )
  }
  const isAfterNode = (identifier: string) => {
    const afterStr = identifier.slice(address.length)
    const number = afterStr.match(/^\.(\d+)/)?.[1]
    if (number === undefined) return false
    const index = Number(number)
    return index > startIndex + deleteCount - 1
  }
  const isInsertNode = (identifier: string) => {
    const afterStr = identifier.slice(address.length)
    const number = afterStr.match(/^\.(\d+)/)?.[1]
    if (number === undefined) return false
    const index = Number(number)
    return index >= startIndex && index < startIndex + insertCount
  }
  const isDeleteNode = (identifier: string) => {
    const preStr = identifier.slice(0, address.length)
    const afterStr = identifier.slice(address.length)
    const number = afterStr.match(/^\.(\d+)/)?.[1]
    if (number === undefined) return false
    const index = Number(number)
    const target = `${preStr}${afterStr.replace(
      /^\.\d+/,
      `.${index + deleteCount}`
    )}`
    return !fields[target]
  }
  const moveIndex = (identifier: string) => {
    if (offset === 0) return identifier
    const preStr = identifier.slice(0, address.length)
    const afterStr = identifier.slice(address.length)
    const number = afterStr.match(/^\.(\d+)/)?.[1]
    if (number === undefined) return identifier
    const index = Number(number) + offset
    return `${preStr}${afterStr.replace(/^\.\d+/, `.${index}`)}`
  }

  runInAction(() => {
    each(fields, (field, identifier) => {
      if (isArrayChildren(identifier)) {
        if (isAfterNode(identifier)) {
          const newIdentifier = moveIndex(identifier)
          fieldPatches.push({
            type: 'update',
            address: newIdentifier,
            payload: buildNodeIndexes(field, newIdentifier),
          })
        }
        if (isInsertNode(identifier) || isDeleteNode(identifier)) {
          fieldPatches.push({ type: 'remove', address: identifier })
        }
      }
    })
    applyFieldPatches(fields, fieldPatches)
  })
  field.form.notify(LifeCycleTypes.ON_FORM_GRAPH_CHANGE)
}

export const exchangeArrayState = (
  field: ArrayField,
  props: IExchangeArrayStateProps
) => {
  const { fromIndex, toIndex } = {
    fromIndex: 0,
    toIndex: 0,
    ...props,
  }
  const address = field.address.toString()
  const fields = field.form.fields
  const fieldPatches: INodePatch<GeneralField>[] = []
  const isArrayChildren = (identifier: string) => {
    return (
      identifier.indexOf(address) === 0 && identifier.length > address.length
    )
  }
  const isCrossNode = (identifier: string) => {
    const afterStr = identifier.slice(address.length)
    const number = afterStr.match(/^\.(\d+)/)?.[1]
    if (number === undefined) return false
    const index = Number(number)
    return (
      (index <= toIndex && index >= fromIndex) ||
      (index >= toIndex && index <= fromIndex)
    )
  }
  const moveIndex = (identifier: string) => {
    const preStr = identifier.slice(0, address.length)
    const afterStr = identifier.slice(address.length)
    const number = afterStr.match(/^\.(\d+)/)?.[1]
    if (number === undefined) return identifier
    const current = Number(number)
    let index = current
    if (index === fromIndex) {
      index = toIndex
    } else {
      if (fromIndex < toIndex) {
        index--
      } else {
        index++
      }
    }

    return `${preStr}${afterStr.replace(/^\.\d+/, `.${index}`)}`
  }
  runInAction(() => {
    each(fields, (field, identifier) => {
      if (isArrayChildren(identifier)) {
        if (isCrossNode(identifier)) {
          const newIdentifier = moveIndex(identifier)
          fieldPatches.push({
            type: 'update',
            address: newIdentifier,
            payload: buildNodeIndexes(field, newIdentifier),
          })
          if (!fields[newIdentifier]) {
            fieldPatches.push({
              type: 'remove',
              address: identifier,
            })
          }
        }
      }
    })
    applyFieldPatches(fields, fieldPatches)
  })
  field.form.notify(LifeCycleTypes.ON_FORM_GRAPH_CHANGE)
}

export const publishUpdate = (field: GeneralField) => {
  const form = field.form
  const updates = FormPath.ensureIn(form, 'requests.updates', [])
  const indexes = FormPath.ensureIn(form, 'requests.updateIndexes', {})
  for (let index = 0; index < updates.length; index++) {
    const { pattern, callbacks } = updates[index]
    let removed = false
    if (field.match(pattern)) {
      callbacks.forEach((callback) => {
        field.setState(callback)
      })
      if (!pattern.isWildMatchPattern && !pattern.isMatchPattern) {
        updates.splice(index--, 1)
        removed = true
      }
    }
    if (!removed) {
      indexes[pattern.toString()] = index
    } else {
      delete indexes[pattern.toString()]
    }
  }
}

export const subscribeUpdate = (
  form: Form,
  pattern: FormPath,
  callback: (...args: any[]) => void
) => {
  const updates = FormPath.ensureIn(form, 'requests.updates', [])
  const indexes = FormPath.ensureIn(form, 'requests.updateIndexes', {})
  const id = pattern.toString()
  const current = indexes[id]
  if (isValid(current)) {
    if (
      updates[current] &&
      !updates[current].callbacks.some((fn: any) =>
        fn.toString() === callback.toString() ? fn === callback : false
      )
    ) {
      updates[current].callbacks.push(callback)
    }
  } else {
    indexes[id] = updates.length
    updates.push({
      pattern,
      callbacks: [callback],
    })
  }
}

export const setModelState = (model: any, setter: any) => {
  if (isFn(setter)) {
    setter(model)
  } else {
    each(GetterSetterProperties, (key) => {
      if (isValid(setter[key])) {
        model[key] = setter[key]
      }
    })
    each(setter, (value, key) => {
      if (isFn(value)) return
      if (ReservedProperties.includes(key)) return
      if (isValid(value)) {
        model[key] = value
      }
    })
  }
}

export const getModelState = (model: any, getter?: any) => {
  if (isFn(getter)) {
    return getter(model)
  } else {
    const results = {}
    each(GetterSetterProperties, (key) => {
      if (isValid(model[key])) {
        results[key] = model[key]
      }
    })
    return reduce(
      model,
      (buf, value, key) => {
        if (isFn(value)) {
          return buf
        }
        if (ReservedProperties.includes(key)) return buf
        if (value && value instanceof FormPath) {
          buf[key] = value.toString()
          return buf
        }
        buf[key] = toJS(value)
        return buf
      },
      results
    )
  }
}

export const createModelStateSetter = (model: any) => {
  return action((state?: any) => setModelState(model, state))
}

export const createModelStateGetter = (model: any) => {
  return (getter?: any) => getModelState(model, getter)
}

export const createFieldStateSetter = (form: Form) => {
  return action((pattern: FormPathPattern, payload?: any) => {
    let matchCount = 0,
      path = FormPath.parse(pattern)
    form.query(path).all.getAll((field) => {
      field.setState(payload)
      matchCount++
    })

    if (matchCount === 0 || path.isWildMatchPattern) {
      subscribeUpdate(form, path, payload)
    }
  })
}
export const createFieldStateGetter = (form: Form) => {
  return (pattern: FormPathPattern, payload?: any) => {
    return form.query(pattern).all.get((field: any) => {
      return field.getState(payload)
    })
  }
}